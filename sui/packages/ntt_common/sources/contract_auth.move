/// The contract authentication system.
///
/// Since Move doesn't have an analogous mechanism to EVM's `msg.sender`, we
/// need a way for contracts to be able to identify themselves for permissioned operations.
///
/// We implement the following scheme:
///
/// If the contract has an `Auth` struct in any of its modules, then we assume
/// only that contract can create a value of that type. If we receive a value of that type,
/// we then assume the contract wanted to call us.
///
/// The fully qualified type identifer is going to be <ADDRESS>::<MODULE>::Auth.
/// Then we take the identity of the contract to be <ADDRESS>.
/// The Sui runtime resolves fully qualified type identifiers with the address
/// that originally defined the type, meaning it will remain constant between
/// contract upgrades.
///
/// It's that <ADDRESS> that for example the ntt manager registers when it sets
/// up a new transceiver.
///
/// The `assert_auth_type` function checks that a reference to such a value is
/// indeed an "auth type", and returns the <ADDRESS> component if it is.
///
/// TODO: are we being too lax about allowing any module name? Maybe we should
/// allow the `assert_auth_type` caller to speficy the name of the auth type it
/// expects. For example, when expecting a transceiver, it might require the
/// auth type to be called `TransceiverAuth`. We could also restrict the module name.
/// The issue with this current approach is that it doesn't allow for
/// fine-grained access control, where a contract that wants to authenticate
/// itself for multiple different operations, it cannot separate those auth
/// types, as they are interchangeable under the current implementation of `assert_auth_type`.
module ntt_common::contract_auth {
    use std::type_name;
    use sui::address;
    use sui::hex;

    #[error]
    const EInvalidAuthType: vector<u8> =
        b"Invalid auth type";

    public fun get_auth_address<Auth>(): Option<address> {
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
