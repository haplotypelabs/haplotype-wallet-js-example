import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
createApp(config).listen(config.port, () => {
  console.log(`Example app listening on ${config.appUrl} (port ${config.port})`);
  console.log(`Wallet: ${config.walletIssuer.origin}, MCP: ${config.walletMcpUrl}`);
});
