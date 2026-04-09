pragma solidity ^0.8.20;

import {BaseMakeitTest} from "./BaseMakeitTest.t.sol";
import {MakeitHarnessV2} from "./helpers/MakeitHarnessV2.sol";

contract MakeitUpgradeTest is BaseMakeitTest {
    function testOnlyOwnerCanUpgrade() public {
        MakeitHarnessV2 newImplementation = new MakeitHarnessV2();

        vm.prank(stranger);
        vm.expectRevert();
        MakeitHarnessV2(payable(address(makeit))).upgradeToAndCall(address(newImplementation), "");
    }

    function testUpgradePreservesState() public {
        _seedAll();
        _openLongTradeAs(trader, DEFAULT_TP_PPM, 10, 20e6);
        uint256 tradeId = _openShortTradeAs(traderTwo, DEFAULT_TP_PPM, 5, 10e6);
        
        uint32 currentLpFeePpm = makeit.liquidityProvisionFeePpm();
        uint32 currentProtocolFeePpm = makeit.protocolFeePpm();
        uint32 currentMaxLeverage = makeit.maxLeverage();
        uint256 currentOpenLongNotional = makeit.openLongNotionalUSDC();
        uint256 currentOpenShortNotional = makeit.openShortNotionalUSDC();
        
        MakeitHarnessV2 newImplementation = new MakeitHarnessV2();

        MakeitHarnessV2 upgraded = MakeitHarnessV2(payable(address(makeit)));
        upgraded.upgradeToAndCall(address(newImplementation), "");

        assertEq(upgraded.owner(), address(this));
        assertEq(upgraded.liquidityProvisionFeePpm(), currentLpFeePpm);
        assertEq(upgraded.protocolFeePpm(), currentProtocolFeePpm);
        assertEq(upgraded.maxLeverage(), currentMaxLeverage);
        assertEq(upgraded.openLongNotionalUSDC(), currentOpenLongNotional);
        assertEq(upgraded.openShortNotionalUSDC(), currentOpenShortNotional);
        assertEq(address(upgraded.priceOracle()), address(oracle));
        assertEq(address(upgraded.externalDex()), address(adapter));

        MakeitHarnessV2.Trade memory trade = upgraded.getTrade(tradeId);
        assertEq(trade.trader, traderTwo);
        assertEq(uint256(trade.side), uint256(1)); // Side.SHORT
        assertEq(uint256(trade.status), 0); // Status.OPEN

        upgraded.setUpgradeMarker(77);
        assertEq(upgraded.upgradeMarker(), 77);
    }
}
