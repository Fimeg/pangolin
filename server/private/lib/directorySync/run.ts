// Usage: npx tsx server/private/lib/directorySync/run.ts <idpId>
// Runs one directory sync for the IdP using its saved directory role mapping.
import { runDirectorySync } from "./runSync";

const idpId = Number(process.argv[2]);
if (!idpId) {
    console.error("Usage: run.ts <idpId>");
    process.exit(1);
}

runDirectorySync(idpId)
    .then((report) => {
        console.log(JSON.stringify(report, null, 2));
        process.exit(0);
    })
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
