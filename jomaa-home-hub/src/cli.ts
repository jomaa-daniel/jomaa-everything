// Command-line options. main.ts imports this first: matter.js also parses
// process.argv when it loads, turning every --flag into a setting of its own,
// so the hub reads its flags here and then hides them.
import { parseArgs } from "node:util";

const usage = `Usage: node dist/main.js [options]

  --config PATH             device and room layout (default config.json)
  --matter-storage DIR      Matter fabric and pairing data (default data/matter)
  --bluetooth-adapter ID    HCI id of the adapter for Bluetooth pairing (default: off)
  --no-matter               run without the Matter controller (Govee-only homes, tests)`;

export interface CliOptions {
  config: string;
  matterStorage: string;
  /** HCI id of the Bluetooth adapter; null leaves Bluetooth off. */
  bluetoothAdapter: number | null;
  matter: boolean;
}

export function parseCli(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: "string", default: "config.json" },
      "matter-storage": { type: "string", default: "data/matter" },
      "bluetooth-adapter": { type: "string" },
      "no-matter": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(usage);
    process.exit(0);
  }
  const adapter = values["bluetooth-adapter"] ?? "";
  if (adapter !== "" && !/^\d+$/.test(adapter)) {
    throw new Error(`--bluetooth-adapter must be an HCI id like 0, got ${JSON.stringify(adapter)}`);
  }
  return {
    config: values.config,
    matterStorage: values["matter-storage"],
    bluetoothAdapter: adapter === "" ? null : Number(adapter),
    matter: !values["no-matter"],
  };
}

export const cliOptions = parseCli(process.argv.slice(2));
process.argv = process.argv.slice(0, 2);
