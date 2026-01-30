import { assertChain, type Chain } from "@wormhole-foundation/sdk";
import { colors } from "./colors.js";
import { checkNumberFormatting, formatNumber } from "./limitFormatting.js";
import type { Deployment } from "./validation";

export function checkConfigErrors(
  deployments: Partial<{ [C in Chain]: Deployment<Chain> }>
): number {
  let errorCount = 0;
  for (const [chain, deployment] of Object.entries(deployments)) {
    assertChain(chain);
    if (!deployment) {
      console.error(`ERROR: ${chain} is missing deployment configuration.`);
      errorCount++;
      continue;
    }
    const localConfig = deployment.config.local;
    if (!localConfig) {
      console.error(`ERROR: ${chain} is missing local config in deployment.`);
      errorCount++;
      continue;
    }
    const config = localConfig;
    if (!checkNumberFormatting(config.limits.outbound, deployment.decimals)) {
      console.error(
        `ERROR: ${chain} has an outbound limit (${config.limits.outbound}) with the wrong number of decimals. The number should have ${deployment.decimals} decimals.`
      );
      errorCount++;
    }
    if (config.limits.outbound === formatNumber(0n, deployment.decimals)) {
      console.warn(colors.yellow(`${chain} has an outbound limit of 0`));
    }
    for (const [inboundChain, limit] of Object.entries(config.limits.inbound)) {
      if (!checkNumberFormatting(limit, deployment.decimals)) {
        console.error(
          `ERROR: ${chain} has an inbound limit with the wrong number of decimals for ${inboundChain} (${limit}). The number should have ${deployment.decimals} decimals.`
        );
        errorCount++;
      }
      if (limit === formatNumber(0n, deployment.decimals)) {
        console.warn(
          colors.yellow(
            `${chain} has an inbound limit of 0 from ${inboundChain}`
          )
        );
      }
    }
  }
  return errorCount;
}
