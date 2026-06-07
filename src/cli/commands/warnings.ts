import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, renderJson } from "../shared.js";
import { ReiseError } from "../../client/errors.js";

export function registerWarningCommands(program: Command, deps: CliDeps): void {
  program
    .command("list")
    .description("All travel warnings, keyed by content id (raw response)")
    .action(
      action(deps, async ({ client, global }) => {
        renderJson(deps, global, await client.list());
      }),
    );

  program
    .command("countries")
    .description("Flattened country overview (id, country, warning flags)")
    .option("--warned-only", "only countries with a warning of any kind in force")
    .action(
      action(deps, async ({ client, global, opts }) => {
        let entries = await client.summaries();
        if (opts["warnedOnly"]) {
          entries = entries.filter(
            (e) => e.warning || e.partialWarning || e.situationWarning || e.situationPartWarning,
          );
        }
        renderJson(deps, global, entries);
      }),
    );

  program
    .command("get <contentId>")
    .description("One country's full travel warning (with HTML content)")
    .action(
      action(deps, async ({ client, global }, [id]) => {
        // An empty content id is structurally invalid: reject it as a usage
        // error instead of issuing a request to a trailing-slash URL that can
        // only ever 404.
        if (!id || id.trim() === "") {
          throw new ReiseError("Missing required argument: contentId must not be empty.");
        }
        renderJson(deps, global, await client.get(id));
      }),
    );
}
