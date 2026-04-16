pragma solidity ^0.8.20;

import {IPriceOracleV3} from "../../src/interfaces/IPriceOracleV3.sol";

contract MockPriceOracle is IPriceOracleV3 {
    uint256 public priceE18;

    constructor(uint256 initialPriceE18) {
        priceE18 = initialPriceE18;
    }

    function setPriceE18(uint256 newPriceE18) external {
        priceE18 = newPriceE18;
    }

    function getPriceE18() external view returns (uint256) {
        return priceE18;
    }
}
