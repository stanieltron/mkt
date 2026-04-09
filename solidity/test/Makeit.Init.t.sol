pragma solidity ^0.8.20;

import {BaseMakeitTest} from "./BaseMakeitTest.t.sol";
import {Makeit} from "../src/Makeit.sol";
import {MakeitProxy} from "../src/MakeitProxy.sol";

contract MakeitInitTest is BaseMakeitTest {
    function testInitializeSetsDefaults() public view {
        assertEq(makeit.owner(), address(this));
        assertEq(makeit.USDC(), address(usdc));
        assertEq(makeit.WETH(), address(weth));
        assertEq(address(makeit.priceOracle()), address(oracle));
        assertEq(address(makeit.externalDex()), address(adapter));
        assertEq(makeit.maxLeverage(), 300);
        assertEq(makeit.liquidityProvisionFeePpm(), 7_000);
        assertEq(makeit.protocolFeePpm(), 3_000);
        assertEq(makeit.nextTradeId(), 1);
        assertEq(makeit.openLongNotionalUSDC(), 0);
        assertEq(makeit.openShortNotionalUSDC(), 0);
        assertEq(makeit.tradingIsFrozen(), false);
    }

    function testImplementationInitializeReverts() public {
        vm.expectRevert();
        implementation.initialize(address(usdc), address(weth), address(this));
    }

    function testProxyInitializeRevertsOnZeroAddresses() public {
        Makeit freshImplementation = new Makeit();
        vm.expectRevert(Makeit.InvalidAddress.selector);
        new MakeitProxy(
            address(freshImplementation),
            abi.encodeCall(Makeit.initialize, (address(0), address(weth), address(this)))
        );

        freshImplementation = new Makeit();
        vm.expectRevert(Makeit.InvalidAddress.selector);
        new MakeitProxy(
            address(freshImplementation),
            abi.encodeCall(Makeit.initialize, (address(usdc), address(0), address(this)))
        );

        freshImplementation = new Makeit();
        vm.expectRevert(Makeit.InvalidAddress.selector);
        new MakeitProxy(
            address(freshImplementation),
            abi.encodeCall(Makeit.initialize, (address(usdc), address(weth), address(0)))
        );
    }

    function testCannotInitializeProxyTwice() public {
        vm.expectRevert();
        makeit.initialize(address(usdc), address(weth), address(this));
    }
}
