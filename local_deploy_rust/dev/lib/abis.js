const MAKEIT_ABI_V3 = [
  "function USDC() view returns (address)",
  "function WETH() view returns (address)",
  "function openNotionalUSDC() view returns (uint256)",
  "function openMarginUSDC() view returns (uint256)",
  "function liquidate(uint256 tradeId)",
  "function nextTradeId() view returns (uint256)",
  "function getTrade(uint256 tradeId) view returns ((address trader,uint8 status,uint40 openedAt,uint16 profitTargetPct,uint32 leverage,uint96 marginUSDC,uint128 notionalUSDC,uint256 entryPriceE18,uint256 tpPriceE18,uint256 slPriceE18))",
  "event TradeOpened(uint256 indexed tradeId,address indexed trader,uint16 profitTargetPct,uint256 entryPriceE18,uint256 tpPriceE18,uint256 slPriceE18,uint32 leverage,uint256 marginUSDC,uint256 notionalUSDC)",
  "event TradeClosed(uint256 indexed tradeId,address indexed trader,uint8 status,uint256 closePriceE18,uint16 profitTargetPct,uint256 payoutUSDC,int256 pnlUSDC,uint256 soldWETHForTP,uint256 boughtWETHOnSL)"
];

const MAKEIT_ABI_V4 = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function USDC() view returns (address)",
  "function WETH() view returns (address)",
  "function liquidityProvisionFeePpm() view returns (uint32)",
  "function maxLeverage() view returns (uint32)",
  "function protocolFeePpm() view returns (uint32)",
  "function protocolFeeAccruedUSDC() view returns (uint256)",
  "function protocolFeeRecipient() view returns (address)",
  "function openNotionalUSDC() view returns (uint256)",
  "function openMarginUSDC() view returns (uint256)",
  "function openLongNotionalUSDC() view returns (uint256)",
  "function openShortNotionalUSDC() view returns (uint256)",
  "function openLongMarginUSDC() view returns (uint256)",
  "function openShortMarginUSDC() view returns (uint256)",
  "function reservedMarginUSDC() view returns (uint256)",
  "function liquidate(uint256 tradeId)",
  "function nextTradeId() view returns (uint256)",
  "function tradingIsFrozen() view returns (bool)",
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function availableWithdrawalAssets() view returns (uint256)",
  "function getTrade(uint256 tradeId) view returns ((address trader,uint8 side,uint8 status,uint40 openedAt,uint32 profitTargetPpm,uint32 leverage,uint96 marginUSDC,uint128 notionalUSDC,uint256 entryPriceE18,uint256 tpPriceE18,uint256 slPriceE18))",
  "event TradeOpened(uint256 indexed tradeId,address indexed trader,uint8 side,uint32 profitTargetPpm,uint256 entryPriceE18,uint256 tpPriceE18,uint256 slPriceE18,uint32 leverage,uint256 marginUSDC,uint256 notionalUSDC)",
  "event TradeClosed(uint256 indexed tradeId,address indexed trader,uint8 side,uint8 status,uint256 closePriceE18,uint32 profitTargetPpm,uint256 payoutUSDC,int256 pnlUSDC,uint256 soldWETHForProfit,uint256 boughtWETHOnSL)"
];

const ORACLE_ABI = [
  "function getPriceE18() view returns (uint256)"
];

const SWAP_ADAPTER_ABI = [
  "function USDC() view returns (address)",
  "function WETH() view returns (address)",
  "function pool() view returns (address)",
  "function buyWETHWithExactUSDC(uint256 usdcIn6,address payer,address recipient) returns (uint256 usdcSpent6,uint256 wethOut18)",
  "function sellWETHForExactUSDC(uint256 usdcNeeded6,address payer,address recipient) returns (uint256 wethSold18,uint256 usdcOut6)"
];

const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)"
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function transfer(address to,uint256 amount) returns (bool)"
];

module.exports = {
  MAKEIT_ABI_V3,
  MAKEIT_ABI_V4,
  ORACLE_ABI,
  SWAP_ADAPTER_ABI,
  POOL_ABI,
  ERC20_ABI,
};
