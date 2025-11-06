cfg_if! {
    if #[cfg(feature = "shim")] {
        pub mod shim;
        pub use shim::*;
    } else {
        pub mod legacy;
        pub use legacy::*;
    }
}
