pragma solidity ^0.8.20;

import {OwnedV3} from "./OwnedV3.sol";
import {SafeTransferLib} from "./SafeTransferLib.sol";
import {IPriceOracleV3} from "./interfaces/IPriceOracleV3.sol";
import {ISwapAdapterV3} from "./interfaces/ISwapAdapterV3.sol";
import {IUniswapV3PoolMinimal} from "./interfaces/IUniswapV3PoolMinimal.sol";
import {IUniswapV3SwapRouter} from "./interfaces/IUniswapV3SwapRouter.sol";

contract UniswapV3SwapAdapterV3 is OwnedV3, ISwapAdapterV3 {
    using SafeTransferLib for address;

    error InvalidTokenPair();
    error OracleNotSet();
    error InvalidPrice();
    error InvalidSlippageBps();

    uint256 private constant PRICE_E18 = 1e18;
    uint256 private constant USDC_TO_E18 = 1e12;
    uint256 private constant BPS_DENOMINATOR = 10_000;

    address public immutable USDC;
    address public immutable WETH;
    address public pool;

    uint24 public poolFee;
    IUniswapV3SwapRouter public swapRouter;

    IPriceOracleV3 public priceOracle;
    uint16 public maxSlippageBps;

    event PoolSet(address indexed previousPool, address indexed newPool, uint24 newPoolFee);
    event SwapRouterSet(address indexed previousRouter, address indexed newRouter);
    event OracleSet(address indexed previousOracle, address indexed newOracle);
    event MaxSlippageBpsSet(uint16 previousMaxSlippageBps, uint16 newMaxSlippageBps);

    constructor(
        address usdc,
        address weth,
        address initialPool,
        address router,
        address oracle,
        uint16 initialMaxSlippageBps,
        address initialOwner
    ) OwnedV3(initialOwner) {
        if (usdc == address(0) || weth == address(0) || initialPool == address(0) || router == address(0)) {
            revert InvalidAddress();
        }

        if (initialMaxSlippageBps > BPS_DENOMINATOR) revert InvalidSlippageBps();

        USDC = usdc;
        WETH = weth;

        maxSlippageBps = initialMaxSlippageBps;
        emit MaxSlippageBpsSet(0, initialMaxSlippageBps);

        _setPool(initialPool);
        _setSwapRouter(router);
        _setOracle(oracle);
    }

    function setPool(address newPool) external onlyOwner {
        _setPool(newPool);
    }

    function setSwapRouter(address newRouter) external onlyOwner {
        _setSwapRouter(newRouter);
    }

    function setOracle(address oracle) external onlyOwner {
        _setOracle(oracle);
    }

    function setMaxSlippageBps(uint16 newMaxSlippageBps) external onlyOwner {
        if (newMaxSlippageBps > BPS_DENOMINATOR) revert InvalidSlippageBps();
        uint16 previous = maxSlippageBps;
        maxSlippageBps = newMaxSlippageBps;
        emit MaxSlippageBpsSet(previous, newMaxSlippageBps);
    }

    function sellWETHForExactUSDC(
        uint256 usdcNeeded6,
        address payer,
        address recipient
    ) external returns (uint256 wethSold18, uint256 usdcOut6) {
        if (usdcNeeded6 == 0) return (0, 0);

        uint256 quoteWeth18 = _wethFromUsdcCeil(usdcNeeded6, _getPriceE18());
        uint256 maxWethIn18 = _applyBpsCeil(quoteWeth18, BPS_DENOMINATOR + maxSlippageBps);

        WETH.safeTransferFrom(payer, address(this), maxWethIn18);

        wethSold18 = swapRouter.exactOutputSingle(
            IUniswapV3SwapRouter.ExactOutputSingleParams({
                tokenIn: WETH,
                tokenOut: USDC,
                fee: poolFee,
                recipient: recipient,
                amountOut: usdcNeeded6,
                amountInMaximum: maxWethIn18,
                sqrtPriceLimitX96: 0
            })
        );

        if (wethSold18 < maxWethIn18) {
            WETH.safeTransfer(payer, maxWethIn18 - wethSold18);
        }

        usdcOut6 = usdcNeeded6;
    }

    function buyWETHWithExactUSDC(
        uint256 usdcIn6,
        address payer,
        address recipient
    ) external returns (uint256 usdcSpent6, uint256 wethOut18) {
        if (usdcIn6 == 0) return (0, 0);

        usdcSpent6 = usdcIn6;
        USDC.safeTransferFrom(payer, address(this), usdcSpent6);

        uint256 quoteWeth18 = _wethFromUsdcFloor(usdcSpent6, _getPriceE18());
        uint256 minWethOut18 = _applyBpsFloor(quoteWeth18, BPS_DENOMINATOR - maxSlippageBps);

        wethOut18 = swapRouter.exactInputSingle(
            IUniswapV3SwapRouter.ExactInputSingleParams({
                tokenIn: USDC,
                tokenOut: WETH,
                fee: poolFee,
                recipient: recipient,
                amountIn: usdcSpent6,
                amountOutMinimum: minWethOut18,
                sqrtPriceLimitX96: 0
            })
        );
    }

    function _setOracle(address oracle) internal {
        if (oracle == address(0)) revert InvalidAddress();
        address previous = address(priceOracle);
        priceOracle = IPriceOracleV3(oracle);
        emit OracleSet(previous, oracle);
    }

    function _setPool(address newPool) internal {
        if (newPool == address(0)) revert InvalidAddress();

        address token0 = IUniswapV3PoolMinimal(newPool).token0();
        address token1 = IUniswapV3PoolMinimal(newPool).token1();
        bool pairMatches = (token0 == WETH && token1 == USDC) || (token0 == USDC && token1 == WETH);
        if (!pairMatches) revert InvalidTokenPair();

        address previousPool = pool;
        pool = newPool;
        uint24 newPoolFee = IUniswapV3PoolMinimal(newPool).fee();
        poolFee = newPoolFee;

        emit PoolSet(previousPool, newPool, newPoolFee);
    }

    function _setSwapRouter(address newRouter) internal {
        if (newRouter == address(0)) revert InvalidAddress();

        address previousRouter = address(swapRouter);
        if (previousRouter != address(0)) {
            USDC.forceApprove(previousRouter, 0);
            WETH.forceApprove(previousRouter, 0);
        }

        swapRouter = IUniswapV3SwapRouter(newRouter);
        USDC.forceApprove(newRouter, type(uint256).max);
        WETH.forceApprove(newRouter, type(uint256).max);

        emit SwapRouterSet(previousRouter, newRouter);
    }

    function _getPriceE18() internal view returns (uint256 priceE18) {
        IPriceOracleV3 oracle = priceOracle;
        if (address(oracle) == address(0)) revert OracleNotSet();
        priceE18 = oracle.getPriceE18();
        if (priceE18 == 0) revert InvalidPrice();
    }

    function _wethFromUsdcCeil(uint256 usdcAmount6, uint256 priceE18) internal pure returns (uint256 wethAmount18) {
        uint256 num = usdcAmount6 * USDC_TO_E18 * PRICE_E18;
        wethAmount18 = (num + priceE18 - 1) / priceE18;
    }

    function _wethFromUsdcFloor(uint256 usdcAmount6, uint256 priceE18) internal pure returns (uint256 wethAmount18) {
        wethAmount18 = (usdcAmount6 * USDC_TO_E18 * PRICE_E18) / priceE18;
    }

    function _applyBpsCeil(uint256 amount, uint256 bps) internal pure returns (uint256 scaled) {
        scaled = (amount * bps + BPS_DENOMINATOR - 1) / BPS_DENOMINATOR;
    }

    function _applyBpsFloor(uint256 amount, uint256 bps) internal pure returns (uint256 scaled) {
        scaled = (amount * bps) / BPS_DENOMINATOR;
    }
}

