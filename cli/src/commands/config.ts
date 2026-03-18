import * as configuration from "../configuration";

export function createConfigCommand() {
  return {
    command: "config",
    describe: "configuration commands",
    builder: configuration.command,
    handler: () => {}, // yargs handles subcommand dispatch via builder
  };
}
