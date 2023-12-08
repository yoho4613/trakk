const { db, functions, storage } = require('./common/firebase.js')
const { checkKey } = require('./common/auth.js')
const { Firestore } = require('@google-cloud/firestore');
const express = require('express');
const cors = require('cors');
const Papa = require("papaparse");
var stream = require('stream');
const uuid = require("uuid-v4");
const { getAssetSnaps } = require('./common/queries.js')
const { typesense } = require('./common/typeSense.js')
const bucket = storage.bucket();
const app = express();

// Automatically allow cross-origin requests
app.use(cors({ origin: true }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// define an endpoint for exporting condition ratings
app.get('/queryRecords/assets', async(req, res, next) => {
    // extract parameters from request 
    const pass = await checkKey(req, res)
    if (!pass) return next()

    // get org from request
    const org = pass.org

    // get csv asset from request
    let csv = req.query.csv || req.body.csv || false;
    if(csv === 'true' || csv === true) csv = true;
    else csv = false

    // get asset units for the organization from request
    const unitsSnap = await db.collection('orgs').doc(org).collection('units').get();
    const unitQueries = Array.from(unitsSnap.docs).map(async (unitDoc) => {
        const unitId = unitDoc.id;

        // get condition reports for each unit
        const conditionReportsQuery = await unitDoc.ref.collection('reports')
            .where('type', '==', 'condition')
            .where('status.status', '==', 'approved')
            .orderBy('ts.seconds', 'desc')
            .limit(1)
            .get();

        // get condition report data
        const conditionReportsData = conditionReportsQuery.docs.map((reportDoc) => {
            const report = reportDoc.data();
            const assetId = report.assetId;

            // get asset data
            return {
                _id: reportDoc.id,
                _unit: unitId,
                assetId: assetId,
            };
        });

        return conditionReportsData;
    });

    const conditionReportsByUnit = await Promise.all(unitQueries);
    const flattenedData = conditionReportsByUnit.flat();

    // format data and send response
    if(csv) {
        const keys = Object.keys(flattenedData[0] || {});
        const csvData = Papa.unparse(flattenedData, { columns: keys });
        req.set('Content-Disposition', 'attachment; filename="condition-ratings.csv"');
        req.set('Content-Type', 'text/csv');
        res.send(csvData);
    } else {
        res.json({ request: { org, type: 'condition_ratings' }, data: flattenedData });
    }
}
);

app.get('/queryRecords/:type', async (req, res, next) => {
    const type = req.params.type || req.body.type;
    const flat = req.query.flat || req.body.flat || false;
    let csv = req.query.csv || req.body.csv || false;
    if(csv === 'true' || csv === true) csv = true;
    else csv = false
    
    let thumbs = (req.query.thumbs || req.body.thumbs) ? true : false;
    if(thumbs === 'true'|| thumbs === true) thumbs = true;
    else thumbs = false

    let pass = await checkKey(req, res)
    if (!pass) return next()
    let org = pass.org

    if (typeof type !== 'string' || typeof org !== 'string') {
        res.status(400);
        res.send({ error: 'invalid request' });
        return next()
    }

    let where = req.query.where || req.body.where;
    if (typeof where === 'string') where = where.split(',')
    let data = []
    let unitQueries = []
    // const snapshotByID = await db.collection('orgs').doc(org).collection('units').doc(unit).collection('assets').doc(asset).get();
    let units = await db.collection('orgs').doc(org).collection('units').get()
    units.forEach((unit) => {
        // console.log('query unit:', unit.id)
        let q = where ? unit.ref.collection(type).where(where[0], where[1], where[2]) : unit.ref.collection(type)
        unitQueries.push(q.get().then(querySnap => {
            querySnap.forEach((doc) => {
                let d = { _id: doc.id, _unit: unit.id }
                Object.assign(d, doc.data())
                if(type === 'images' && !thumbs) delete d.thumb
                data.push(d)
            })
            return
        }))
    })

    await Promise.all(unitQueries)
    if(flat || csv) {
        let keys = new Set()
        let keysTop = new Set(['_id','_unit'])
        let flatdata = []
        if(type === 'images') {
            keysTop.add('_roots')
            keysTop.add('imageID')
            keysTop.add('assets')
            keysTop.add('filename')
            keysTop.add('src')
            keysTop.add('ts')
            keysTop.add('label')
        }
        if(type === 'assets') {
            keysTop.add('_root')
            keysTop.add('assetID')
            keysTop.add('parent')
            keysTop.add('images')
            let orgSnap = await db.collection('orgs').doc(org).get()
            let orgData = orgSnap.data()
            orgData.schema.attributes.forEach(a => { if(a.key) keys.add(a.key) })
        }
        data.forEach(({ _id, _unit, root, roots, assetID, imageID, images, assets, geometry, parent, attributes, label, imageName, src, ts }) => {
            let fd = { _id, _unit, parent }
            if(type === 'assets') {
                fd.assetID = assetID
                fd._root = root
                fd.images = (images || []).join(' ')
            }
            if(type === 'images') {
                fd.imageID = imageID
                fd._roots = (roots || []).join(' ')
                fd.assets = (assets || []).join(' ')
                Object.assign(fd, { imageID, label, filename: imageName, src, ts })
                if(attributes) Object.keys(attributes).forEach(k => { keys.add(k) })
            }
            if(geometry && (geometry || {}).type === 'Point') {
                fd._lat = geometry.coordinates[0];
                fd._lon = geometry.coordinates[1];
            }
            if(attributes) Object.assign(fd, attributes)
            flatdata.push(fd)
        });
        ['_lat', '_lon', 'type'].forEach(k => keysTop.add(k))
        keysTop = Array.from(keysTop)
        keysTop.forEach(k => keys.add(k))
        keys = Array.from(keys)
        keys.sort((a, b) => {
        let aTop = keysTop.findIndex((v) => { return v === a })
        let bTop = keysTop.findIndex((v) => { return v === b })
        // console.log(a, b, aTop, bTop)
        if(aTop >= 0 && bTop >= 0) {
            if(aTop > bTop) return 1
            else if (aTop < bTop) return -1
            return 0
        }
        if(aTop >= 0) return -1
        if(bTop >= 0) return 1
        if (a > b) return 1
        else if (a < b) return -1
        return 0
        })
        if(csv) data = Papa.unparse(flatdata, { columns: keys })
        else data = flatdata
    }
    let fileData = csv ? data : JSON.stringify({ request: { org, type, where }, data });
    let fileName = `queryRecords_${type}`
    let fileType = 'application/json'
    if(csv) {
        fileName += '.csv'
        fileType = 'text/csv'
    }
    else fileName += '.json'

    let fileContents = Buffer.from(fileData);
    let readStream = new stream.PassThrough();

    res.set('Content-disposition', 'attachment; filename=' + fileName);
    res.set('Content-Type', fileType);

    readStream.pipe(res);
    readStream.end(fileContents);

    return false
    // return next()
});
