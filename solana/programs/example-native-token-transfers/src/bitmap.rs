use crate::error::NTTError;
use anchor_lang::prelude::*;
use bitmaps::Bitmap as BM;
use std::result::Result as StdResult;
#[derive(PartialEq, Eq, Clone, Copy, Debug, AnchorDeserialize, AnchorSerialize, InitSpace)]
pub struct Bitmap {
    map: u128,
}

impl Default for Bitmap {
    fn default() -> Self {
        Self::new()
    }
}

impl Bitmap {
    pub const BITS: u8 = 128;

    pub fn new() -> Self {
        Bitmap { map: 0 }
    }

    pub fn from_value(value: u128) -> Self {
        Bitmap { map: value }
    }

    pub fn set(&mut self, index: u8, value: bool) -> StdResult<(), NTTError> {
        if index >= Self::BITS {
            return Err(NTTError::BitmapIndexOutOfBounds);
        }
        let mut bm = BM::<128>::from_value(self.map);
        bm.set(usize::from(index), value);
        self.map = *bm.as_value();
        Ok(())
    }

    pub fn get(&self, index: u8) -> StdResult<bool, NTTError> {
        if index >= Self::BITS {
            return Err(NTTError::BitmapIndexOutOfBounds);
        }
        Ok(BM::<128>::from_value(self.map).get(usize::from(index)))
    }

    pub fn count_enabled_votes(&self, enabled: Bitmap) -> u8 {
        let bm = BM::<128>::from_value(self.map) & BM::<128>::from_value(enabled.map);
        bm.len()
            .try_into()
            .expect("Bitmap length must not exceed the bounds of u8")
    }

    pub fn len(self) -> u8 {
        BM::<128>::from_value(self.map)
            .len()
            .try_into()
            .expect("Bitmap length must not exceed the bounds of u8")
    }

    pub fn is_empty(self) -> bool {
        BM::<128>::from_value(self.map).is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bitmap() {
        let mut enabled = Bitmap::from_value(u128::MAX);
        let mut bm = Bitmap::new();
        assert_eq!(bm.count_enabled_votes(enabled), 0);
        bm.set(0, true).unwrap();
        assert_eq!(bm.count_enabled_votes(enabled), 1);
        assert!(bm.get(0).unwrap());
        assert!(!bm.get(1).unwrap());
        bm.set(1, true).unwrap();
        assert_eq!(bm.count_enabled_votes(enabled), 2);
        assert!(bm.get(0).unwrap());
        assert!(bm.get(1).unwrap());
        bm.set(0, false).unwrap();
        assert_eq!(bm.count_enabled_votes(enabled), 1);
        assert!(!bm.get(0).unwrap());
        assert!(bm.get(1).unwrap());
        bm.set(18, true).unwrap();
        assert_eq!(bm.count_enabled_votes(enabled), 2);

        enabled.set(18, false).unwrap();
        assert_eq!(bm.count_enabled_votes(enabled), 1);
    }

    #[test]
    fn test_bitmap_len() {
        let max_bitmap = Bitmap::from_value(u128::MAX);
        assert_eq!(128, max_bitmap.count_enabled_votes(max_bitmap));
    }

    #[test]
    fn test_bitmap_get_out_of_bounds() {
        let bm = Bitmap::new();
        assert_eq!(bm.get(129), Err(NTTError::BitmapIndexOutOfBounds));
    }

    #[test]
    fn test_bitmap_set_out_of_bounds() {
        let mut bm = Bitmap::new();
        assert_eq!(bm.set(129, false), Err(NTTError::BitmapIndexOutOfBounds));
    }
}
