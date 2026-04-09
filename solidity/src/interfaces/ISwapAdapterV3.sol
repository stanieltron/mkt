pragma solidity ^0.8.20;

interface ISwapAdapterV3 {
    function sellWETHForExactUSDC(
        uint256 usdcNeeded6,
        address payer,
        address recipient
    ) external returns (uint256 wethSold18, uint256 usdcOut6);

    function buyWETHWithExactUSDC(
        uint256 usdcIn6,
        address payer,
        address recipient
    ) external returns (uint256 usdcSpent6, uint256 wethOut18);
}

