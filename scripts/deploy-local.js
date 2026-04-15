#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");
const {
  Contract,
  ContractFactory,
  HDNodeWallet,
  Interface,
  JsonRpcProvider,
  NonceManager,
  Wallet,
  encodeBytes32String,
} = require("ethers");

const workspaceRoot = process.cwd();
const protocolVariant = "default";
const solidityLocalRootName = "local_deploy_rust";
const solidityContractRootName = "solidity";
const solidityLocalRoot = resolve(workspaceRoot, solidityLocalRootName);
const solidityContractRoot = resolve(workspaceRoot, solidityContractRootName);
const deploymentDir = resolve(solidityLocalRoot, "deployments");
const localDeployEnvPath = resolve(solidityLocalRoot, ".env");
const e2eRoot = resolve(workspaceRoot, "e2e");
const e2eEnvPath = resolve(e2eRoot, ".env");
mkdirSync(deploymentDir, { recursive: true });

const mnemonic =
  process.env.ANVIL_MNEMONIC || "test test test test test test test test test test test junk";
const rpcUrl = process.env.RPC_URL || process.env.ANVIL_RPC_URL || "http://127.0.0.1:8545";

const backendPort = process.env.BACKEND_PORT || "8787";
const frontendPort = process.env.FRONTEND_PORT || "5173";
const backendUrl = process.env.BACKEND_URL || `http://localhost:${backendPort}`;
const backendUpstreamPort = process.env.LOCAL_BACKEND_UPSTREAM_PORT || "8788";

const postgresHost = process.env.POSTGRES_HOST || process.env.PGHOST || "127.0.0.1";
const postgresPort = process.env.POSTGRES_PORT || process.env.PGPORT || "5434";
const postgresDb = process.env.POSTGRES_DB || process.env.PGDATABASE || "appdb";
const postgresUser = process.env.POSTGRES_USER || process.env.PGUSER || "app";
const postgresPassword = process.env.POSTGRES_PASSWORD || process.env.PGPASSWORD || "app";
const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const databaseUrl =
  process.env.DATABASE_URL ||
  `postgresql://${postgresUser}:${postgresPassword}@${postgresHost}:${postgresPort}/${postgresDb}`;
const adminUsername = process.env.ADMIN_USERNAME || "admin";
const adminPassword = process.env.ADMIN_PASSWORD || "admin123";

function envToBigInt(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return BigInt(defaultValue);
  return BigInt(raw);
}

function envToNumber(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return Number(defaultValue);
  return Number(raw);
}

function deriveWallet(index) {
  return HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${index}`);
}

function assertUniquePrivateKeys(walletMap) {
  const seen = new Map();
  for (const [name, wallet] of Object.entries(walletMap)) {
    const pk = String(wallet?.privateKey || "").toLowerCase();
    if (!pk) continue;
    if (seen.has(pk)) {
      throw new Error(`Duplicate private key detected for ${name} and ${seen.get(pk)}`);
    }
    seen.set(pk, name);
  }
}

async function fundEthFromAnvilWallets({
  provider,
  to,
  amountWei,
  reserveWeiPerWallet = 1n * 10n ** 18n,
  startIndex = 1,
  excludeAddress = "",
}) {
  if (amountWei <= 0n) return;
  let remaining = BigInt(amountWei);
  const excluded = String(excludeAddress || "").toLowerCase();

  for (let i = startIndex; i < 20 && remaining > 0n; i += 1) {
    const funder = new Wallet(deriveWallet(i).privateKey, provider);
    const funderAddress = await funder.getAddress();
    if (excluded && funderAddress.toLowerCase() === excluded) continue;
    const balance = await provider.getBalance(funderAddress);
    if (balance <= reserveWeiPerWallet) continue;

    const available = balance - reserveWeiPerWallet;
    const sendAmount = available < remaining ? available : remaining;
    if (sendAmount <= 0n) continue;

    const tx = await funder.sendTransaction({ to, value: sendAmount });
    await tx.wait();
    remaining -= sendAmount;
  }

  if (remaining > 0n) {
    throw new Error(
      `Unable to fund faucet ETH target. Missing ${remaining.toString()} wei after scanning Anvil wallets.`
    );
  }
}

async function assertRpcAvailable(provider) {
  try {
    await provider.getNetwork();
  } catch (error) {
    console.error(`RPC ${rpcUrl} is not reachable. Start anvil first (npm run anvil).`);
    console.error(String(error?.message || error));
    process.exit(1);
  }
}

function runForgeBuild(root) {
  const res = spawnSync(
    "node",
    ["scripts/forge.js", "build", "--root", root, "-q"],
    {
      stdio: "inherit",
      env: process.env,
      cwd: workspaceRoot,
    }
  );
  if ((res.status ?? 1) !== 0) {
    process.exit(res.status ?? 1);
  }
}

function loadArtifact(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sortTokens(a, b) {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}

function sqrt(value) {
  if (value < 0n) throw new Error("sqrt only works on non-negative values");
  if (value < 2n) return value;
  let x0 = value;
  let x1 = (x0 + value / x0) >> 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + value / x0) >> 1n;
  }
  return x0;
}

function sqrtPriceX96FromUsdcPerWeth(token0, weth, usdcPerWeth6) {
  const amount0 = token0.toLowerCase() === weth.toLowerCase() ? 10n ** 18n : usdcPerWeth6;
  const amount1 = token0.toLowerCase() === weth.toLowerCase() ? usdcPerWeth6 : 10n ** 18n;
  const ratioX192 = (amount1 << 192n) / amount0;
  return sqrt(ratioX192);
}

function linkBytecode(artifact, libraries) {
  const refs = artifact.linkReferences || {};
  let bytecode = artifact.bytecode.startsWith("0x") ? artifact.bytecode.slice(2) : artifact.bytecode;

  for (const fileName of Object.keys(refs)) {
    for (const libName of Object.keys(refs[fileName])) {
      const linkedAddress = libraries[libName] || libraries[`${fileName}:${libName}`];
      if (!linkedAddress) {
        throw new Error(`Missing library address for ${fileName}:${libName}`);
      }
      const normalized = linkedAddress.toLowerCase().replace(/^0x/, "");
      if (normalized.length !== 40) {
        throw new Error(`Invalid library address for ${fileName}:${libName}`);
      }

      for (const ref of refs[fileName][libName]) {
        const start = ref.start * 2;
        const length = ref.length * 2;
        bytecode =
          bytecode.slice(0, start) +
          normalized.padStart(length, "0") +
          bytecode.slice(start + length);
      }
    }
  }

  return `0x${bytecode}`;
}

function ensureAddress(address, label) {
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(String(address))) {
    throw new Error(`Invalid address for ${label}: ${String(address)}`);
  }
  return address;
}

async function addressOf(contract, label) {
  return ensureAddress(await contract.getAddress(), label);
}

function tickSpacingForFee(fee) {
  if (fee === 100) return 1;
  if (fee === 500) return 10;
  if (fee === 3000) return 60;
  if (fee === 10000) return 200;
  throw new Error(`Unsupported fee tier: ${fee}`);
}

async function deployContract(name, artifact, signer, args = []) {
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log(`${name} deployed: ${address}`);
  return contract;
}

async function deployUpgradeableContract(name, implementationArtifact, proxyArtifact, signer, initArgs = []) {
  const implementation = await deployContract(`${name}Implementation`, implementationArtifact, signer);
  const implementationAddress = await addressOf(implementation, `${name}Implementation`);
  const initData = new Interface(implementationArtifact.abi).encodeFunctionData("initialize", initArgs);
  const proxy = await deployContract(`${name}Proxy`, proxyArtifact, signer, [implementationAddress, initData]);
  const proxyAddress = await addressOf(proxy, `${name}Proxy`);
  const contract = new Contract(proxyAddress, implementationArtifact.abi, signer);

  return {
    implementation,
    implementationAddress,
    proxy,
    proxyAddress,
    contract,
  };
}

async function mintAndFund({
  weth,
  usdc,
  usdt,
  signer,
  recipient,
  wethAmount18,
  usdcAmount6,
  usdtAmount6,
  nativeTopupWei,
}) {
  if (wethAmount18 > 0n) {
    const tx = await weth.connect(signer).mint(recipient, wethAmount18, { value: wethAmount18 });
    await tx.wait();
  }
  if (usdcAmount6 > 0n) {
    const tx = await usdc.connect(signer).mint(recipient, usdcAmount6);
    await tx.wait();
  }
  if (usdt && usdtAmount6 > 0n) {
    const tx = await usdt.connect(signer).mint(recipient, usdtAmount6);
    await tx.wait();
  }
  if (nativeTopupWei > 0n) {
    const tx = await signer.sendTransaction({ to: recipient, value: nativeTopupWei });
    await tx.wait();
  }
}

function envText(values) {
  return (
    Object.entries(values)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join("\n") + "\n"
  );
}

function formatEth(wei) {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 6);
  return `${whole.toString()}.${frac}`;
}

function frontendGeneratedNetworkText(values) {
  return `export const GENERATED_NETWORK = ${JSON.stringify(values, null, 2)};\n`;
}

function writeEnvFiles(deployment, wallets) {
  const testWalletEnv = {};
  for (let i = 1; i <= 10; i += 1) {
    const key = `test${i}`;
    const wallet = wallets[key];
    if (!wallet) continue;
    testWalletEnv[`TEST_WALLET_${i}_PRIVATE_KEY`] = wallet.privateKey;
    testWalletEnv[`TEST_WALLET_${i}_ADDRESS`] = wallet.address;
  }

  const localDeployEnv = {
    PROTOCOL_VARIANT: deployment.protocolVariant,
    LOCAL_MODE: "true",
    RPC_URL: rpcUrl,
    CHAIN_ID: "31337",
    CHAIN_NAME: "Anvil Local",
    DEPLOYER_PRIVATE_KEY: wallets.deployer.privateKey,
    USER1_PRIVATE_KEY: wallets.user1.privateKey,
    USER2_PRIVATE_KEY: wallets.user2.privateKey,
    RUNNER_PRIVATE_KEY: wallets.runner.privateKey,
    BOT_PRIVATE_KEY: wallets.bot.privateKey,
    FAUCET_PRIVATE_KEY: wallets.faucet.privateKey,
    SWAPPER_PRIVATE_KEY: wallets.swapper.privateKey,
    FAUCET_ETH_WEI: deployment.faucet?.ethWei || "1000000000000000000",
    FAUCET_USDC_6: "1000000000",
    FAUCET_COOLDOWN_MS: "3600000",
    FAUCET_TARGET_CLAIMS: deployment.faucet?.targetClaims || "1000000",
    LOCAL_BACKEND_UPSTREAM_PORT: backendUpstreamPort,
    USER1_ADDRESS: wallets.user1.address,
    USER2_ADDRESS: wallets.user2.address,
    RUNNER_ADDRESS: wallets.runner.address,
    BOT_ADDRESS: wallets.bot.address,
    SWAPPER_ADDRESS: wallets.swapper.address,
    FAUCET_ADDRESS: deployment.faucet?.address || "",
    WETH_ADDRESS: deployment.weth,
    USDC_ADDRESS: deployment.usdc,
    USDT_ADDRESS: deployment.usdt,
    UNISWAP_FACTORY_ADDRESS: deployment.factory,
    UNISWAP_ROUTER_ADDRESS: deployment.router,
    UNISWAP_ROUTER_COMPAT_ADDRESS: deployment.routerCompat,
    POSITION_MANAGER_ADDRESS: deployment.nonfungiblePositionManager,
    UNISWAP_POOL_ADDRESS: deployment.pool,
    ORACLE_ADDRESS: deployment.oracle,
    SWAP_ADAPTER_ADDRESS: deployment.swapAdapter,
    MAKEIT_ADDRESS: deployment.makeit,
    POOL_FEE: String(deployment.poolFee),
    BACKEND_PORT: backendPort,
    FRONTEND_PORT: frontendPort,
    BACKEND_URL: backendUrl,
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    POSTGRES_HOST: postgresHost,
    POSTGRES_PORT: postgresPort,
    POSTGRES_DB: postgresDb,
    POSTGRES_USER: postgresUser,
    POSTGRES_PASSWORD: postgresPassword,
    ADMIN_USERNAME: adminUsername,
    ADMIN_PASSWORD: adminPassword,
    SWAP_RUNNER_ENABLED: "false",
    SWAP_RUNNER_INTERVAL_MS: "1000",
    SWAP_RUNNER_BASE_NOTIONAL_USDC_6: "10000000",
    SWAP_RUNNER_TREND: "0",
    SWAP_RUNNER_VOLATILITY: "0.20",
    LIQUIDATION_BOT_INTERVAL_MS: "2000",
    INITIAL_PRICE_USDC_6_PER_WETH: deployment.initialPriceUsdc6PerWeth,
    ...testWalletEnv,
  };

  const frontendDir = resolve(workspaceRoot, "frontend");
  mkdirSync(frontendDir, { recursive: true });

  mkdirSync(solidityLocalRoot, { recursive: true });
  mkdirSync(e2eRoot, { recursive: true });
  writeFileSync(localDeployEnvPath, envText(localDeployEnv), "utf8");

  const e2eEnv = {
    RPC_URL: localDeployEnv.RPC_URL,
    BACKEND_URL: localDeployEnv.BACKEND_URL,
    LOCAL_BACKEND_UPSTREAM_PORT: localDeployEnv.LOCAL_BACKEND_UPSTREAM_PORT,
    DATABASE_URL: localDeployEnv.DATABASE_URL,
    DEPLOYER_PRIVATE_KEY: localDeployEnv.DEPLOYER_PRIVATE_KEY,
    MAKEIT_ADDRESS: localDeployEnv.MAKEIT_ADDRESS,
    ORACLE_ADDRESS: localDeployEnv.ORACLE_ADDRESS,
    SWAP_ADAPTER_ADDRESS: localDeployEnv.SWAP_ADAPTER_ADDRESS,
    WETH_ADDRESS: localDeployEnv.WETH_ADDRESS,
    USDC_ADDRESS: localDeployEnv.USDC_ADDRESS,
    SWAPPER_PRIVATE_KEY: localDeployEnv.SWAPPER_PRIVATE_KEY,
    ...testWalletEnv,
  };
  writeFileSync(e2eEnvPath, envText(e2eEnv), "utf8");

  const frontendGeneratedDir = resolve(frontendDir, "src", "generated");
  mkdirSync(frontendGeneratedDir, { recursive: true });
  const frontendGeneratedNetwork = {
    chainId: Number(localDeployEnv.CHAIN_ID),
    chainName: Number(localDeployEnv.CHAIN_ID) === 31337 ? "Anvil Local" : `Chain ${localDeployEnv.CHAIN_ID}`,
    makeit: deployment.makeit,
    protocolVariant: deployment.protocolVariant,
    backendProtocolVariant: deployment.protocolVariant,
    defaultProtocolVariant: deployment.protocolVariant,
    oracle: deployment.oracle,
    swapAdapter: deployment.swapAdapter,
    usdc: deployment.usdc,
    usdt: deployment.usdt,
    weth: deployment.weth,
    runnerAddress: wallets.runner.address,
    swapperAddress: wallets.swapper.address,
    faucetAddress: deployment.faucet?.address || "",
    pool: deployment.pool,
    rpcUrl: localDeployEnv.RPC_URL,
    backendUrl: backendUrl,
    localMode: true,
    adminDefaultUser: adminUsername,
    adminDefaultPassword: adminPassword,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(
    resolve(frontendGeneratedDir, "network.generated.js"),
    frontendGeneratedNetworkText(frontendGeneratedNetwork),
    "utf8"
  );
}

async function main() {
  const provider = new JsonRpcProvider(rpcUrl);
  await assertRpcAvailable(provider);

  const hdWallets = {
    deployer: deriveWallet(0),
    user1: deriveWallet(1),
    user2: deriveWallet(2),
    runner: deriveWallet(3),
    bot: deriveWallet(4),
    faucet: deriveWallet(5),
    swapper: deriveWallet(6),
    test1: deriveWallet(10),
    test2: deriveWallet(11),
    test3: deriveWallet(12),
    test4: deriveWallet(13),
    test5: deriveWallet(14),
    test6: deriveWallet(15),
    test7: deriveWallet(16),
    test8: deriveWallet(17),
    test9: deriveWallet(18),
    test10: deriveWallet(19),
  };
  assertUniquePrivateKeys(hdWallets);

  const wallets = {
    deployer: new NonceManager(new Wallet(hdWallets.deployer.privateKey, provider)),
    user1: hdWallets.user1,
    user2: hdWallets.user2,
    runner: hdWallets.runner,
    bot: hdWallets.bot,
    faucet: hdWallets.faucet,
    swapper: hdWallets.swapper,
  };

  runForgeBuild(solidityLocalRootName);
  runForgeBuild(solidityContractRootName);

  const artifacts = {
    mockWeth: loadArtifact(resolve(solidityLocalRoot, "out", "MockWETH.sol", "MockWETH.json")),
    mockErc20: loadArtifact(resolve(solidityLocalRoot, "out", "MockERC20.sol", "MockERC20.json")),
    localFaucet: loadArtifact(resolve(solidityLocalRoot, "out", "LocalFaucet.sol", "LocalFaucet.json")),
    makeit: loadArtifact(resolve(solidityContractRoot, "out", "Makeit.sol", "Makeit.json")),
    makeitProxy: loadArtifact(resolve(solidityContractRoot, "out", "MakeitProxy.sol", "MakeitProxy.json")),
    oracle: loadArtifact(
      resolve(solidityContractRoot, "out", "UniswapV3PoolOracleV3.sol", "UniswapV3PoolOracleV3.json")
    ),
    swapAdapter: loadArtifact(
      resolve(solidityContractRoot, "out", "UniswapV3SwapAdapterV3.sol", "UniswapV3SwapAdapterV3.json")
    ),
    swapRouterCompat: loadArtifact(resolve(solidityLocalRoot, "out", "SwapRouterCompat.sol", "SwapRouterCompat.json")),
    v3Factory: loadArtifact(
      resolve(
        workspaceRoot,
        "solidity",
        "vendor_artifacts",
        "uniswap",
        "v3-core",
        "contracts",
        "UniswapV3Factory.json"
      )
    ),
    v3Pool: loadArtifact(
      resolve(
        workspaceRoot,
        "solidity",
        "vendor_artifacts",
        "uniswap",
        "v3-core",
        "contracts",
        "UniswapV3Pool.json"
      )
    ),
    swapRouter: loadArtifact(
      resolve(
        workspaceRoot,
        "solidity",
        "vendor_artifacts",
        "uniswap",
        "v3-periphery",
        "contracts",
        "SwapRouter.json"
      )
    ),
    positionDescriptor: loadArtifact(
      resolve(
        workspaceRoot,
        "solidity",
        "vendor_artifacts",
        "uniswap",
        "v3-periphery",
        "contracts",
        "NonfungibleTokenPositionDescriptor.json"
      )
    ),
    nftDescriptorLib: loadArtifact(
      resolve(
        workspaceRoot,
        "solidity",
        "vendor_artifacts",
        "uniswap",
        "v3-periphery",
        "contracts",
        "libraries",
        "NFTDescriptor.json"
      )
    ),
    positionManager: loadArtifact(
      resolve(
        workspaceRoot,
        "solidity",
        "vendor_artifacts",
        "uniswap",
        "v3-periphery",
        "contracts",
        "NonfungiblePositionManager.json"
      )
    ),
  };

  const cfg = {
    poolFee: envToNumber("POOL_FEE", 3000),
    maxSlippageBps: envToNumber("MAX_SLIPPAGE_BPS", 100),
    initialPriceUsdc6PerWeth: envToBigInt("INITIAL_PRICE_USDC_6_PER_WETH", "2000000000"),
    marginUsdc6: envToBigInt("MAKEIT_MARGIN_USDC_6", "10000000"),
    maxLeverage: envToNumber("MAKEIT_MAX_LEVERAGE", 300),
    deployerWethMint18: envToBigInt("DEPLOYER_WETH_MINT_18", "1200000000000000000000"),
    deployerUsdcMint6: envToBigInt("DEPLOYER_USDC_MINT_6", "5000000000000"),
    deployerUsdtMint6: envToBigInt("DEPLOYER_USDT_MINT_6", "5000000000000"),
    initialLiquidityWeth18: envToBigInt("INITIAL_LIQUIDITY_WETH_18", "600000000000000000000"),
    initialLiquidityUsdc6: envToBigInt("INITIAL_LIQUIDITY_USDC_6", "1200000000000"),
    makeitFundWeth18: envToBigInt("MAKEIT_FUND_WETH_18", "10000000000000000000"),
    makeitFundUsdc6: envToBigInt("MAKEIT_FUND_USDC_6", "0"),
    runnerWeth18: envToBigInt("RUNNER_WETH_18", "12000000000000000000000"),
    runnerUsdc6: envToBigInt("RUNNER_USDC_6", "50000000000000000000000"),
    runnerUsdt6: envToBigInt("RUNNER_USDT_6", "50000000000000000000000"),
    runnerNativeTopUpWei: envToBigInt("RUNNER_NATIVE_TOPUP_WEI", "0"),
    swapperWeth18: envToBigInt("SWAPPER_WETH_18", "240000000000000000000"),
    swapperUsdc6: envToBigInt("SWAPPER_USDC_6", "2000000000000"),
    swapperUsdt6: envToBigInt("SWAPPER_USDT_6", "2000000000000"),
    swapperNativeTopUpWei: envToBigInt("SWAPPER_NATIVE_TOPUP_WEI", "0"),
    botWeth18: envToBigInt("BOT_WETH_18", "60000000000000000000"),
    botUsdc6: envToBigInt("BOT_USDC_6", "200000000000"),
    botUsdt6: envToBigInt("BOT_USDT_6", "200000000000"),
    botNativeTopUpWei: envToBigInt("BOT_NATIVE_TOPUP_WEI", "0"),
    user1Weth18: envToBigInt("USER1_WETH_18", "10000000000000000000"),
    user1Usdc6: envToBigInt("USER1_USDC_6", "120000000000"),
    user1Usdt6: envToBigInt("USER1_USDT_6", "120000000000"),
    user1NativeTopUpWei: envToBigInt("USER1_NATIVE_TOPUP_WEI", "0"),
    user2Weth18: envToBigInt("USER2_WETH_18", "10000000000000000000"),
    user2Usdc6: envToBigInt("USER2_USDC_6", "120000000000"),
    user2Usdt6: envToBigInt("USER2_USDT_6", "120000000000"),
    user2NativeTopUpWei: envToBigInt("USER2_NATIVE_TOPUP_WEI", "0"),
    faucetClaimEthWei: envToBigInt("FAUCET_ETH_WEI", "1000000000000000000"),
    faucetClaimUsdc6: envToBigInt("FAUCET_USDC_6", "1000000000"),
    faucetCooldownMs: envToBigInt("FAUCET_COOLDOWN_MS", "3600000"),
    faucetTargetClaims: envToBigInt("FAUCET_TARGET_CLAIMS", "1000000"),
    faucetFundEthWei: 0n,
    faucetFundUsdc6: 0n,
  };

  cfg.faucetFundEthWei = envToBigInt(
    "FAUCET_FUND_ETH_WEI",
    (cfg.faucetClaimEthWei * cfg.faucetTargetClaims).toString()
  );
  cfg.faucetFundUsdc6 = envToBigInt(
    "FAUCET_FUND_USDC_6",
    (cfg.faucetClaimUsdc6 * cfg.faucetTargetClaims).toString()
  );

  const deployer = wallets.deployer;
  const deployerAddress = await deployer.getAddress();
  console.log(`Deployer: ${deployerAddress}`);
  console.log(`Runner wallet: ${wallets.runner.address}`);
  console.log(`Runner private key: ${hdWallets.runner.privateKey}`);
  console.log(`Swapper wallet: ${wallets.swapper.address}`);
  console.log(`Swapper private key: ${hdWallets.swapper.privateKey}`);

  const requiredWethBackingWei =
    cfg.deployerWethMint18 +
    cfg.runnerWeth18 +
    cfg.swapperWeth18 +
    cfg.botWeth18 +
    cfg.user1Weth18 +
    cfg.user2Weth18;
  const deployerBalanceWei = await provider.getBalance(deployerAddress);
  if (deployerBalanceWei < requiredWethBackingWei) {
    throw new Error(
      `Insufficient deployer ETH for MockWETH mint backing. Need ${formatEth(requiredWethBackingWei)} ETH, ` +
      `have ${formatEth(deployerBalanceWei)} ETH. Reduce *_WETH_18 env values (especially RUNNER_WETH_18).`
    );
  }

  const weth = await deployContract("MockWETH", artifacts.mockWeth, deployer);
  const wethAddress = await addressOf(weth, "MockWETH");
  const usdc = await deployContract("MockUSDC", artifacts.mockErc20, deployer, [
    "Mock USD Coin",
    "mUSDC",
    6,
  ]);
  const usdcAddress = await addressOf(usdc, "MockUSDC");
  const usdt = await deployContract("MockUSDT", artifacts.mockErc20, deployer, [
    "Mock Tether USD",
    "mUSDT",
    6,
  ]);
  const usdtAddress = await addressOf(usdt, "MockUSDT");
  const localFaucet = await deployContract("LocalFaucet", artifacts.localFaucet, deployer, [
    usdcAddress,
    cfg.faucetClaimEthWei,
    cfg.faucetClaimUsdc6,
    cfg.faucetCooldownMs,
  ]);
  const localFaucetAddress = await addressOf(localFaucet, "LocalFaucet");

  const v3Factory = await deployContract("UniswapV3Factory", artifacts.v3Factory, deployer);
  const v3FactoryAddress = await addressOf(v3Factory, "UniswapV3Factory");
  const swapRouter = await deployContract("SwapRouter", artifacts.swapRouter, deployer, [
    v3FactoryAddress,
    wethAddress,
  ]);
  const swapRouterAddress = await addressOf(swapRouter, "SwapRouter");
  const swapRouterCompat = await deployContract("SwapRouterCompat", artifacts.swapRouterCompat, deployer, [
    swapRouterAddress,
  ]);
  const swapRouterCompatAddress = await addressOf(swapRouterCompat, "SwapRouterCompat");
  const nftDescriptorLib = await deployContract("NFTDescriptorLib", artifacts.nftDescriptorLib, deployer);
  const nftDescriptorLibAddress = await addressOf(nftDescriptorLib, "NFTDescriptorLib");
  const positionDescriptorArtifact = {
    ...artifacts.positionDescriptor,
    bytecode: linkBytecode(artifacts.positionDescriptor, {
      NFTDescriptor: nftDescriptorLibAddress,
    }),
  };
  const descriptor = await deployContract(
    "NonfungibleTokenPositionDescriptor",
    positionDescriptorArtifact,
    deployer,
    [wethAddress, encodeBytes32String("ETH")]
  );
  const descriptorAddress = await addressOf(descriptor, "NonfungibleTokenPositionDescriptor");
  const positionManager = await deployContract(
    "NonfungiblePositionManager",
    artifacts.positionManager,
    deployer,
    [v3FactoryAddress, wethAddress, descriptorAddress]
  );
  const positionManagerAddress = await addressOf(positionManager, "NonfungiblePositionManager");

  await mintAndFund({
    weth,
    usdc,
    usdt,
    signer: deployer,
    recipient: deployerAddress,
    wethAmount18: cfg.deployerWethMint18,
    usdcAmount6: cfg.deployerUsdcMint6,
    usdtAmount6: cfg.deployerUsdtMint6,
    nativeTopupWei: 0n,
  });

  await mintAndFund({
    weth,
    usdc,
    usdt,
    signer: deployer,
    recipient: wallets.runner.address,
    wethAmount18: cfg.runnerWeth18,
    usdcAmount6: cfg.runnerUsdc6,
    usdtAmount6: cfg.runnerUsdt6,
    nativeTopupWei: cfg.runnerNativeTopUpWei,
  });
  await mintAndFund({
    weth,
    usdc,
    usdt,
    signer: deployer,
    recipient: wallets.swapper.address,
    wethAmount18: cfg.swapperWeth18,
    usdcAmount6: cfg.swapperUsdc6,
    usdtAmount6: cfg.swapperUsdt6,
    nativeTopupWei: cfg.swapperNativeTopUpWei,
  });
  await mintAndFund({
    weth,
    usdc,
    usdt,
    signer: deployer,
    recipient: wallets.bot.address,
    wethAmount18: cfg.botWeth18,
    usdcAmount6: cfg.botUsdc6,
    usdtAmount6: cfg.botUsdt6,
    nativeTopupWei: cfg.botNativeTopUpWei,
  });
  await mintAndFund({
    weth,
    usdc,
    usdt,
    signer: deployer,
    recipient: wallets.user1.address,
    wethAmount18: cfg.user1Weth18,
    usdcAmount6: cfg.user1Usdc6,
    usdtAmount6: cfg.user1Usdt6,
    nativeTopupWei: cfg.user1NativeTopUpWei,
  });
  await mintAndFund({
    weth,
    usdc,
    usdt,
    signer: deployer,
    recipient: wallets.user2.address,
    wethAmount18: cfg.user2Weth18,
    usdcAmount6: cfg.user2Usdc6,
    usdtAmount6: cfg.user2Usdt6,
    nativeTopupWei: cfg.user2NativeTopUpWei,
  });

  if (cfg.faucetFundUsdc6 > 0n) {
    const tx = await usdc.mint(localFaucetAddress, cfg.faucetFundUsdc6);
    await tx.wait();
  }
  if (cfg.faucetFundEthWei > 0n) {
    await fundEthFromAnvilWallets({
      provider,
      to: localFaucetAddress,
      amountWei: cfg.faucetFundEthWei,
      startIndex: 1,
      excludeAddress: deployerAddress,
    });
  }

  const [token0, token1] = sortTokens(wethAddress, usdcAddress);
  const sqrtPriceX96 = sqrtPriceX96FromUsdcPerWeth(token0, wethAddress, cfg.initialPriceUsdc6PerWeth);
  const createPoolTx = await positionManager.createAndInitializePoolIfNecessary(
    token0,
    token1,
    cfg.poolFee,
    sqrtPriceX96
  );
  await createPoolTx.wait();
  const poolAddress = await v3Factory.getPool(token0, token1, cfg.poolFee);
  ensureAddress(poolAddress, "UniswapV3Pool");
  console.log(`Uniswap pool: ${poolAddress}`);

  const approveNpmTx1 = await weth.approve(positionManagerAddress, 2n ** 256n - 1n);
  await approveNpmTx1.wait();
  const approveNpmTx2 = await usdc.approve(positionManagerAddress, 2n ** 256n - 1n);
  await approveNpmTx2.wait();

  const spacing = tickSpacingForFee(cfg.poolFee);
  const minTick = -887272;
  const maxTick = 887272;
  const tickLower = Math.trunc(minTick / spacing) * spacing;
  const tickUpper = Math.trunc(maxTick / spacing) * spacing;

  const amount0Desired = token0.toLowerCase() === wethAddress.toLowerCase()
    ? cfg.initialLiquidityWeth18
    : cfg.initialLiquidityUsdc6;
  const amount1Desired = token1.toLowerCase() === usdcAddress.toLowerCase()
    ? cfg.initialLiquidityUsdc6
    : cfg.initialLiquidityWeth18;

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const mintLiquidityTx = await positionManager.mint({
    token0,
    token1,
    fee: cfg.poolFee,
    tickLower,
    tickUpper,
    amount0Desired,
    amount1Desired,
    amount0Min: 0,
    amount1Min: 0,
    recipient: deployerAddress,
    deadline,
  });
  await mintLiquidityTx.wait();

  const pool = new Contract(poolAddress, artifacts.v3Pool.abi, provider);
  const slot0 = await pool.slot0();
  if (!slot0 || slot0.sqrtPriceX96 === 0n) {
    throw new Error("Pool slot0 not initialized correctly");
  }

  const oracle = await deployContract("UniswapV3PoolOracleV3", artifacts.oracle, deployer, [
    poolAddress,
    usdcAddress,
    wethAddress,
    deployerAddress,
  ]);
  const oracleAddress = await addressOf(oracle, "UniswapV3PoolOracleV3");
  const swapAdapter = await deployContract("UniswapV3SwapAdapterV3", artifacts.swapAdapter, deployer, [
    usdcAddress,
    wethAddress,
    poolAddress,
    swapRouterCompatAddress,
    oracleAddress,
    cfg.maxSlippageBps,
    deployerAddress,
  ]);
  const swapAdapterAddress = await addressOf(swapAdapter, "UniswapV3SwapAdapterV3");
  const makeitDeployment = await deployUpgradeableContract(
    "Makeit",
    artifacts.makeit,
    artifacts.makeitProxy,
    deployer,
    [usdcAddress, wethAddress, deployerAddress]
  );
  const makeit = makeitDeployment.contract;
  const makeitAddress = makeitDeployment.proxyAddress;
  const makeitImplementationAddress = makeitDeployment.implementationAddress;

  async function configureMakeit(contract, makeitAddr) {
    const setOracleTx = await contract.setOracle(oracleAddress);
    await setOracleTx.wait();
    const setDexTx = await contract.setExternalDex(swapAdapterAddress);
    await setDexTx.wait();
    const setFeeSplitTx = await contract.setFeeSplitPpm(70, 30);
    await setFeeSplitTx.wait();

    const setMaxLevTx = await contract.setMaxLeverage(cfg.maxLeverage);
    await setMaxLevTx.wait();

    const approveMakeitTx1 = await weth.approve(makeitAddr, 2n ** 256n - 1n);
    await approveMakeitTx1.wait();
    const approveMakeitTx2 = await usdc.approve(makeitAddr, 2n ** 256n - 1n);
    await approveMakeitTx2.wait();

    const whitelistTx = await contract.configureLpProvision(deployerAddress, true, 2n ** 256n - 1n);
    await whitelistTx.wait();

    if (cfg.makeitFundWeth18 > 0n) {
      const tx = await contract.deposit(cfg.makeitFundWeth18, deployerAddress);
      await tx.wait();
    }
  }

  await configureMakeit(makeit, makeitAddress);

  const network = await provider.getNetwork();
  const deployment = {
    protocolVariant,
    defaultProtocolVariant: protocolVariant,
    chainId: Number(network.chainId),
    deployer: deployerAddress,
    weth: wethAddress,
    usdc: usdcAddress,
    usdt: usdtAddress,
    factory: v3FactoryAddress,
    router: swapRouterAddress,
    routerCompat: swapRouterCompatAddress,
    nonfungiblePositionManager: positionManagerAddress,
    positionDescriptor: descriptorAddress,
    pool: poolAddress,
    poolFee: cfg.poolFee,
    initialPriceUsdc6PerWeth: cfg.initialPriceUsdc6PerWeth.toString(),
    oracle: oracleAddress,
    swapAdapter: swapAdapterAddress,
    makeit: makeitAddress,
    maxSlippageBps: cfg.maxSlippageBps,
    marginUsdc: cfg.marginUsdc6.toString(),
    maxLeverage: cfg.maxLeverage,
    runnerAddress: wallets.runner.address,
    botAddress: wallets.bot.address,
    swapperAddress: wallets.swapper.address,
    testWallets: Array.from({ length: 10 }, (_, idx) => {
      const i = idx + 1;
      const wallet = hdWallets[`test${i}`];
      return {
        index: i,
        address: wallet.address,
      };
    }),
    faucet: {
      address: localFaucetAddress,
      ethWei: cfg.faucetClaimEthWei.toString(),
      usdc6: cfg.faucetClaimUsdc6.toString(),
      cooldownMs: Number(cfg.faucetCooldownMs),
      targetClaims: cfg.faucetTargetClaims.toString(),
      fundEthWei: cfg.faucetFundEthWei.toString(),
      fundUsdc6: cfg.faucetFundUsdc6.toString(),
    },
    user1Address: wallets.user1.address,
    user2Address: wallets.user2.address,
  };

  const outFile = resolve(deploymentDir, "local.json");
  writeFileSync(outFile, JSON.stringify(deployment, null, 2), "utf8");
  writeEnvFiles(deployment, hdWallets);

  console.log(`Deployment written to ${outFile} (${protocolVariant})`);
  console.log(`Generated local deploy env: ${localDeployEnvPath}`);
  console.log(`Generated e2e env: ${e2eEnvPath}`);
}

if (!existsSync(resolve(workspaceRoot, "scripts", "forge.js"))) {
  console.error("scripts/forge.js not found.");
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
