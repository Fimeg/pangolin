import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const addon = JSON.stringify(require.resolve("better-sqlite3"));

for (const explicitClose of [true, false]) {
    test(`native SQLite survives GC and exit with explicitClose=${explicitClose}`, () => {
        const result = spawnSync(process.execPath, ["--expose-gc", "-e", `
            const Database = require(${addon});
            for (let pass = 0; pass < 400; pass++) {
                const db = new Database(':memory:');
                db.exec('CREATE TABLE fixture(value INTEGER)');
                db.prepare('INSERT INTO fixture VALUES (?)').run(pass);
                if (db.prepare('SELECT value FROM fixture').get().value !== pass) process.exit(2);
                if (${explicitClose}) db.close();
                if (pass % 10 === 0) global.gc();
            }
            global.gc();
        `], { encoding: "utf8", timeout: 30000 });
        assert.ifError(result.error);
        assert.equal(result.signal, null, result.stderr);
        assert.equal(result.status, 0, result.stderr);
    });
}

test("native SQLite survives worker termination with live database handles", () => {
    const result = spawnSync(process.execPath, ["-e", `
        const { Worker } = require('node:worker_threads');
        (async () => {
            for (let pass = 0; pass < 5; pass++) {
                const worker = new Worker(\`
                    const { parentPort } = require('node:worker_threads');
                    const Database = require(${addon});
                    global.database = new Database(':memory:');
                    global.statement = database.prepare('SELECT 1');
                    parentPort.postMessage(statement.get());
                    setInterval(() => statement.get(), 50);
                \`, { eval: true });
                await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
                await worker.terminate();
            }
        })().catch(error => { console.error(error); process.exitCode = 1; });
    `], { encoding: "utf8", timeout: 30000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
});
