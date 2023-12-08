/common/firebase.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore()
const storage = admin.storage()
Object.assign(exports, {
    db,
    storage,
    functions,
    admin
})