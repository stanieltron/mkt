use ethers::types::Address;
use rand::{distributions::Alphanumeric, Rng};
use std::str::FromStr;

pub fn normalize_address(wallet: &str) -> anyhow::Result<String> {
    let parsed: Address = Address::from_str(wallet)
        .map_err(|_| anyhow::anyhow!("Invalid address: {}", wallet))?;
    // Return lowercase hex — matches Node normalizeAddress behaviour
    Ok(format!("{:#x}", parsed))
}

pub fn is_address_like(wallet: &str) -> bool {
    Address::from_str(wallet).is_ok()
}

pub fn random_referral_code(len: usize) -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(len)
        .map(char::from)
        .collect::<String>()
        .to_uppercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_address_valid() {
        let input = "0x9E545E3C0baAB3E08CdfD552C960A1050f373042";
        let res = normalize_address(input).unwrap();
        assert_eq!(res, "0x9e545e3c0baab3e08cdfd552c960a1050f373042");

        let input_no_0x = "9E545E3C0baAB3E08CdfD552C960A1050f373042";
        let res_no_0x = normalize_address(input_no_0x).unwrap();
        assert_eq!(res_no_0x, "0x9e545e3c0baab3e08cdfd552c960a1050f373042");
    }

    #[test]
    fn test_normalize_address_invalid() {
        let input = "0x123";
        assert!(normalize_address(input).is_err());
    }

    #[test]
    fn test_is_address_like() {
        assert!(is_address_like("0x9E545E3C0baAB3E08CdfD552C960A1050f373042"));
        assert!(is_address_like("9E545E3C0baAB3E08CdfD552C960A1050f373042"));
        assert!(!is_address_like("not-an-address"));
        assert!(!is_address_like("0x123"));
    }

    #[test]
    fn test_random_referral_code() {
        let code1 = random_referral_code(8);
        assert_eq!(code1.len(), 8);
        assert!(code1.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()));

        let code2 = random_referral_code(12);
        assert_eq!(code2.len(), 12);
        assert_ne!(code1, code2);
    }
}
