const fs = require("fs");
const { prepareV2Campaign } = require("../lib/policy-v2-source");

async function main() {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) throw new Error("usage: node scripts/prepare-v2-campaign.js <draft.json> <output.json>");
  const draft = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const prepared = await prepareV2Campaign(draft);
  fs.writeFileSync(outputPath, JSON.stringify(prepared, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(`Wrote v2 ruleHash and manifestHash to ${outputPath}`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
