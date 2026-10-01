'use strict';
const path = require('node:path');
const config = require('./config');
const { openDb } = require('./db');
const { createApp } = require('./app');

const db = openDb(path.join(config.dataDir, 'taarangana.db'));
createApp({ db, config }).listen(config.port, () => console.log(`Taarangana 2026 platform on ${config.baseUrl} (port ${config.port})`));
