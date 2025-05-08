module ntt::auth {
    public struct ManagerAuth has drop {}

    public(package) fun new_auth(): ManagerAuth {
        ManagerAuth {}
    }
}
