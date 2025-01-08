module ntt::auth {
    public struct Auth has drop {}

    public(package) fun new_auth(): Auth {
        Auth {}
    }
}
