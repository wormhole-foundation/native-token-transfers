import { connection, getProgramAddresses } from "./env";
import { NTT } from "../sdk";

(async () => {
  const programs = getProgramAddresses();
  const ntt = new NTT(connection, {
    nttId: programs.nttProgramId as any,
    wormholeId: programs.wormholeProgramId as any,
  });

  // console.log("outbox rate limit account:", await ntt.outboxRateLimitAccountAddress());
  console.log("mintAccountAddress", (await ntt.mintAccountAddress()).toString());
  const accountInfo = await connection.getParsedAccountInfo(await ntt.mintAccountAddress())
  if (accountInfo.value === null) {
    console.log("Account not found.");
    return;
  }
  console.log("pared account info", accountInfo.value.data);
  console.log("Success.");
})();

