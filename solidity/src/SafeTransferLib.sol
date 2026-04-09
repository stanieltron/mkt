pragma solidity ^0.8.20;

library SafeTransferLib {
    error TransferFailed();
    error TransferFromFailed();
    error ApproveFailed();

    function safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFromFailed();
    }

    function forceApprove(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        if (ok && (data.length == 0 || abi.decode(data, (bool)))) return;

        (ok, data) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, 0));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert ApproveFailed();

        (ok, data) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert ApproveFailed();
    }
}

