
/common/queries.js
const { db } = require('./firebase.js')
const getAssetSnaps = async (org, asset = false) => {
    let units = []
    const unitsSnap = await db.collection('orgs').doc(org).collection('units').get()
    unitsSnap.forEach(u => {
        units.push(String(u.id))
    })
    let result = []
    let unitQueries = []
    units.forEach(uid => {
    unitQueries.push((async () => {
        const unitRef = db.collection('orgs').doc(org).collection('units').doc(uid)
        if(asset) {
            const assetSnap = await unitRef.collection('assets').doc(asset).get()
            if (assetSnap.exists) {
                result.push(assetSnap)
            }
            else {
                let snapshotAssets = await unitRef.collection('assets').where('assetID', '==', asset).get()
                snapshotAssets.forEach(assetSnap => {
                    result.push(assetSnap)
                });
            }
        }
        else {
            let snapshotAssets = await unitRef.collection('assets').get()
            snapshotAssets.forEach(assetSnap => {
                result.push(assetSnap)
            });
        }
    })())
    })
    await Promise.all(unitQueries)
    return result
}

Object.assign(exports, {
    getAssetSnaps
})