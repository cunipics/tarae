const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const projectDir = path.resolve(__dirname, '..');
const schemaPath = path.join(projectDir, 'sql', 'schema.sql');
const outputDir = path.join(projectDir, 'build', 'seed');
const outputPath = path.join(outputDir, 'cms.db');

if (!fs.existsSync(schemaPath)) {
  throw new Error(`데이터베이스 스키마를 찾을 수 없습니다: ${schemaPath}`);
}

fs.mkdirSync(outputDir, { recursive: true });
if (fs.existsSync(outputPath)) {
  fs.rmSync(outputPath, { force: true });
}

const database = new DatabaseSync(outputPath);
try {
  database.exec('PRAGMA foreign_keys = ON;');
  database.exec(fs.readFileSync(schemaPath, 'utf8'));
  database.exec('PRAGMA optimize; VACUUM;');
} finally {
  database.close();
}

console.log(`Seed database created: ${outputPath}`);
