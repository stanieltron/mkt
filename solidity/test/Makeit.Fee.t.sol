pragma solidity ^0.8.20;

import {BaseMakeitTest} from "./BaseMakeitTest.t.sol";
import {Makeit} from "../src/Makeit.sol";

contract MakeitFeeTest is BaseMakeitTest {
    function testDefaultFees() public view {
        assertEq(makeit.liquidityProvisionFeePpm(), 7_000);
        assertEq(makeit.protocolFeePpm(), 3_000);
    }

    function testSetFeeSplitUpdatesFutureLongTradeMargin() public {
        _seedMakeit();
        makeit.setFeeSplitPpm(10_000, 5_000);

        uint96 margin = 10e6;
        uint256 tradeId = _openLongTradeAs(trader, DEFAULT_TP_PPM, 10, margin);
        Makeit.Trade memory trade = makeit.getTrade(tradeId);
        
        uint256 totalFee = _calculateFee(margin, 10, 15_000);
        uint256 expectedEffectiveMargin = uint256(margin) - totalFee;

        assertEq(trade.marginUSDC, expectedEffectiveMargin);
        assertEq(trade.notionalUSDC, expectedEffectiveMargin * 10);
    }

    function testSetFeeSplitUpdatesFutureShortTradeMargin() public {
        _seedMakeit();
        _openLongTradeAs(trader, DEFAULT_TP_PPM, 10, 20e6);
        makeit.setFeeSplitPpm(10_000, 5_000);

        _openLongTradeAs(trader, DEFAULT_TP_PPM, 10, 20e6); // $20 margin * 10x, enough for shorts
        uint96 margin = 10e6;
        uint256 tradeId = _openShortTradeAs(traderTwo, DEFAULT_TP_PPM, 5, margin);
        Makeit.Trade memory trade = makeit.getTrade(tradeId);
        
        uint256 totalFee = _calculateFee(margin, 5, 15_000);
        uint256 expectedEffectiveMargin = uint256(margin) - totalFee;

        assertEq(trade.marginUSDC, expectedEffectiveMargin);
        assertEq(trade.notionalUSDC, expectedEffectiveMargin * 5);
    }

    function testInvalidFeeSplitReverts() public {
        vm.expectRevert(abi.encodeWithSelector(Makeit.InvalidFeeSplit.selector, 800_000, 300_000));
        makeit.setFeeSplitPpm(800_000, 300_000);
    }

    function testEffectiveMarginTooSmallReverts() public {
        _seedMakeit();
        uint256 expectedPriceE18 = _expectedPrice();
        // 100% fee
        makeit.setFeeSplitPpm(1_000_000, 0);

        vm.startPrank(trader);
        vm.expectRevert(abi.encodeWithSelector(Makeit.EffectiveMarginTooSmall.selector, 10e6));
        makeit.openLongTrade(expectedPriceE18, 100, DEFAULT_TP_PPM, 10, 10e6);
        vm.stopPrank();
    }

    function testSetFeeSplitAccruesProtocolBucket() public {
        _seedMakeit();
        makeit.setFeeSplitPpm(7_000, 3_000);

        uint96 margin = 10e6;
        uint256 tradeId = _openLongTradeAs(trader, DEFAULT_TP_PPM, 50, margin); // Use 50x instead of 100x
        Makeit.Trade memory trade = makeit.getTrade(tradeId);

        uint256 protocolFee = (uint256(margin) * 50 * 3_000) / 1_000_000;

        assertEq(makeit.protocolFeeAccruedUSDC(), protocolFee);
    }

    function testSweepProtocolFeesTransfersOnlyProtocolBucket() public {
        _seedMakeit();
        makeit.setFeeSplitPpm(7_000, 3_000);
        makeit.setProtocolFeeRecipient(treasury);

        _openLongTradeAs(trader, DEFAULT_TP_PPM, 50, 10e6);

        uint256 accrued = makeit.protocolFeeAccruedUSDC();
        uint256 treasuryBefore = usdc.balanceOf(treasury);
        makeit.sweepProtocolFees();

        assertEq(makeit.protocolFeeAccruedUSDC(), 0);
        assertEq(usdc.balanceOf(treasury) - treasuryBefore, accrued);
    }
}
