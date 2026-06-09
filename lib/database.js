'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// A thin singleton around a better-sqlite3 connection. Tracks-apps talk to
// the DB exclusively through Model, but migrations and the console use this
// directly. Convention: the dev database lives at <root>/db/development.sqlite3.
let connection = null;
let dbPath = null;

function connect(root, env = process.env.TRACKS_ENV || 'development') {
  if (connection) return connection;
  const dir = path.join(root, 'db');
  fs.mkdirSync(dir, { recursive: true });
  dbPath = path.join(dir, `${env}.sqlite3`);
  connection = new Database(dbPath);
  connection.pragma('journal_mode = WAL');
  connection.pragma('foreign_keys = ON');
  return connection;
}

function db() {
  if (!connection) throw new Error('Database not connected. Call Tracks.database.connect(root) first.');
  return connection;
}

function close() {
  if (connection) {
    connection.close();
    connection = null;
  }
}

module.exports = { connect, db, close, get path() { return dbPath; } };
