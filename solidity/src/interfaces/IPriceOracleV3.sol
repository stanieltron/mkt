pragma solidity ^0.8.20;

interface IPriceOracleV3 {
    function getPriceE18() external view returns (uint256 priceE18);
}

