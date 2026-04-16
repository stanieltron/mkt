pragma solidity ^0.8.20;

interface IERC20Like {
    function transfer(address to, uint256 amount) external returns (bool);
}

contract LocalFaucet {
    IERC20Like public immutable usdc;
    uint256 public immutable ethAmountWei;
    uint256 public immutable usdcAmount6;
    uint256 public immutable cooldownMs;

    mapping(address => uint256) public lastClaimAt;

    event Claimed(address indexed caller, address indexed recipient, uint256 ethAmountWei, uint256 usdcAmount6, uint256 claimedAt);
    event Funded(address indexed from, uint256 amount);

    error CooldownActive(uint256 retryAfterMs);
    error EthTransferFailed();
    error TokenTransferFailed();
    error InvalidRecipient();

    constructor(address usdcAddress, uint256 claimEthAmountWei, uint256 claimUsdcAmount6, uint256 claimCooldownMs) {
        usdc = IERC20Like(usdcAddress);
        ethAmountWei = claimEthAmountWei;
        usdcAmount6 = claimUsdcAmount6;
        cooldownMs = claimCooldownMs;
    }

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    function claim() external {
        claimTo(msg.sender);
    }

    function claimTo(address recipient) public {
        if (recipient == address(0)) revert InvalidRecipient();

        uint256 lastClaim = lastClaimAt[recipient];
        uint256 nowMs = block.timestamp * 1000;
        if (cooldownMs > 0 && lastClaim > 0 && nowMs < lastClaim + cooldownMs) {
            revert CooldownActive(lastClaim + cooldownMs - nowMs);
        }

        lastClaimAt[recipient] = nowMs;

        if (ethAmountWei > 0) {
            (bool ok, ) = recipient.call{value: ethAmountWei}("");
            if (!ok) revert EthTransferFailed();
        }

        if (usdcAmount6 > 0) {
            bool ok = usdc.transfer(recipient, usdcAmount6);
            if (!ok) revert TokenTransferFailed();
        }

        emit Claimed(msg.sender, recipient, ethAmountWei, usdcAmount6, nowMs);
    }
}
