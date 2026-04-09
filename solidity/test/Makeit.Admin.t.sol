pragma solidity ^0.8.20;

import {BaseMakeitTest} from "./BaseMakeitTest.t.sol";
import {MockPriceOracle} from "./helpers/MockPriceOracle.sol";
import {MockSwapAdapter} from "./helpers/MockSwapAdapter.sol";
import {Makeit} from "../src/Makeit.sol";

contract MakeitAdminTest is BaseMakeitTest {
    function testOnlyOwnerCanSetOracle() public {
        MockPriceOracle newOracle = new MockPriceOracle(2_500e18);
        vm.expectRevert();
        vm.prank(stranger);
        makeit.setOracle(address(newOracle));

        makeit.setOracle(address(newOracle));
        assertEq(address(makeit.priceOracle()), address(newOracle));
    }

    function testOnlyOwnerCanSetExternalDex() public {
        MockSwapAdapter newAdapter = new MockSwapAdapter(address(usdc), address(weth), address(oracle));
        vm.expectRevert();
        vm.prank(stranger);
        makeit.setExternalDex(address(newAdapter));

        makeit.setExternalDex(address(newAdapter));
        assertEq(address(makeit.externalDex()), address(newAdapter));
    }

    function testOnlyOwnerCanSetMaxLeverage() public {
        vm.expectRevert();
        vm.prank(stranger);
        makeit.setMaxLeverage(500);

        makeit.setMaxLeverage(500);
        assertEq(makeit.maxLeverage(), 500);
    }

    function testOnlyOwnerCanSetFeeSplit() public {
        vm.expectRevert();
        vm.prank(stranger);
        makeit.setFeeSplitPpm(5_000, 5_000);

        makeit.setFeeSplitPpm(5_000, 5_000);
        assertEq(makeit.liquidityProvisionFeePpm(), 5_000);
        assertEq(makeit.protocolFeePpm(), 5_000);
    }

    function testOnlyOwnerCanSetTradingFrozen() public {
        vm.expectRevert();
        vm.prank(stranger);
        makeit.setTradingFrozen(true);

        makeit.setTradingFrozen(true);
        assertEq(makeit.tradingIsFrozen(), true);
    }
}
