/// The contract authentication system.
///
/// Since Move doesn't have an analogous mechanism to EVM's `msg.sender`, we
/// need a way for contracts to be able to identify themselves for permissioned operations.
///
/// We implement the following scheme:
///
/// We pick a struct name, e.g. "SomeAuth". If the contract has a struct defined
/// with that name in any of its modules, then we assume only that contract can
/// create a value of that type. If we receive a value of that type, we then
/// assume the contract wanted to call us. Here it's important to pick a struct
/// name that's unique so the module was not already going to define it for any
/// other reason than authentication with this module.
///
/// Each consumer of an authentication type should use a different name. That
/// way, the program can handle access control in a fine grained way.
///
/// The fully qualified type identifer is going to be <ADDRESS>::<MODULE>::SomeAuth.
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
module ntt_common::contract_auth {
    use std::type_name;
    use sui::address;
    use sui::hex;

    #[error]
    const EInvalidAuthType: vector<u8> =
        b"Invalid auth type";

    public fun get_auth_address<Auth>(type_name: vector<u8>): Option<address> {
        let fqt = type_name::get<Auth>();

        let address_hex = fqt.get_address().into_bytes();
        let addy = address::from_bytes(hex::decode(address_hex));

        let mod = fqt.get_module().into_bytes();

        let mut expected = address_hex;
        expected.append(b"::");
        expected.append(mod);
        expected.append(b"::");
        expected.append(type_name);

        if (fqt.into_string().into_bytes() == expected) {
            option::some(addy)
        } else {
            option::none()
        }
    }

    public fun is_auth_type<Auth>(type_name: vector<u8>): bool {
        get_auth_address<Auth>(type_name).is_some()
    }

    public fun assert_auth_type<Auth>(_auth: &Auth, type_name: vector<u8>): address {
        let maybe_addy = get_auth_address<Auth>(type_name);
        if (maybe_addy.is_none()) {
            abort EInvalidAuthType
        };
        *maybe_addy.borrow()
    }
}

#[test_only]
module ntt_common::auth {
    public struct MyAuth {}
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
        assert!(is_auth_type<ntt_common::auth::MyAuth>(b"MyAuth"));
        assert!(is_auth_type<ntt_common::other_auth::Auth>(b"Auth"));
        assert!(!is_auth_type<NotAuth>(b"SomeAuth"));
    }
}
