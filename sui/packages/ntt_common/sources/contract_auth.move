// TODO: document auth flow.
//
// <address>::<MOD>::Auth => contract authorised as 'address'.
module ntt_common::contract_auth {
    use std::type_name;
    use sui::address;
    use sui::hex;

    #[error]
    const EInvalidAuthType: vector<u8> =
        b"Invalid auth type";

    fun get_auth_address<Auth>(): Option<address> {
        let fqt = type_name::get<Auth>();

        let address_hex = fqt.get_address().into_bytes();
        let addy = address::from_bytes(hex::decode(address_hex));

        let mod = fqt.get_module().into_bytes();

        let mut expected = address_hex;
        expected.append(b"::");
        expected.append(mod);
        expected.append(b"::Auth");

        if (fqt.into_string().into_bytes() == expected) {
            option::some(addy)
        } else {
            option::none()
        }
    }

    public fun is_auth_type<Auth>(): bool {
        get_auth_address<Auth>().is_some()
    }

    public fun assert_auth_type<Auth>(auth: &Auth): address {
        let maybe_addy = get_auth_address<Auth>();
        if (maybe_addy.is_none()) {
            abort EInvalidAuthType
        };
        *maybe_addy.borrow()
    }
}

#[test_only]
module ntt_common::auth {
    public struct Auth {}
}

#[test_only]
module ntt_common::other_auth {
    public struct Auth {}
}

#[test_only]
module ntt_common::contract_auth_test {
    use ntt_common::contract_auth::is_auth_type;

    public struct NotAuth {}

    #[test]
    public fun test_is_auth_type() {
        assert!(is_auth_type<ntt_common::auth::Auth>());
        assert!(is_auth_type<ntt_common::other_auth::Auth>());
        assert!(!is_auth_type<NotAuth>());
    }
}
