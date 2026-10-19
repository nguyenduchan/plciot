#!/usr/bin/env node
/** Rebuild Mosquitto ACL from users table and SIGHUP broker. */
import path from 'path';
import { openDb } from '../src/db.js';
import { rebuildAclFromUsers, reloadMosquitto } from '../src/mqttProvision.js';

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const db = openDb(DATA_DIR);
const n = rebuildAclFromUsers(db);
const r = reloadMosquitto();
console.log(`ACL rebuilt for ${n} users`, r);
