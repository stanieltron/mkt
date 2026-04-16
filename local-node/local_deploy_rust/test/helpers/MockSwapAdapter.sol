pragma solidity ^0.8.20;

import {SafeTransferLib} from "solidity/src/SafeTransferLib.sol";
import {IPriceOracleV3} from "solidity/src/interfaces/IPriceOracleV3.sol";
import {ISwapAdapterV3} from "solidity/src/interfaces/ISwapAdapterV3.sol";

contract MockSwapAdapter is ISwapAdapterV3 {
    using SafeTransferLib for address;

    uint256 private constant PRICE_E18 = 1e18;
    uint256 private constant USDC_TO_E18 = 1e12;

    address public immutable USDC;
    address public immutable WETH;
    IPriceOracleV3 public immutable oracle;

    constructor(address usdc, address weth, address priceOracle) {
        USDC = usdc;
        WETH = weth;
        oracle = IPriceOracleV3(priceOracle);
    }

    function sellWETHForExactUSDC(
        uint256 usdcNeeded6,
        address payer,
        address recipient
    ) external returns (uint256 wethSold18, uint256 usdcOut6) {
        if (usdcNeeded6 == 0) return (0, 0);

        uint256 priceE18 = oracle.getPriceE18();
        wethSold18 = ((usdcNeeded6 * USDC_TO_E18 * PRICE_E18) + priceE18 - 1) / priceE18;
        WETH.safeTransferFrom(payer, address(this), wethSold18);
        USDC.safeTransfer(recipient, usdcNeeded6);
        usdcOut6 = usdcNeeded6;
    }

    function buyWETHWithExactUSDC(
        uint256 usdcIn6,
        address payer,
        address recipient
    ) external returns (uint256 usdcSpent6, uint256 wethOut18) {
        if (usdcIn6 == 0) return (0, 0);

        uint256 priceE18 = oracle.getPriceE18();
        usdcSpent6 = usdcIn6;
        wethOut18 = (usdcIn6 * USDC_TO_E18 * PRICE_E18) / priceE18;
        USDC.safeTransferFrom(payer, address(this), usdcSpent6);
        WETH.safeTransfer(recipient, wethOut18);
    }
}
