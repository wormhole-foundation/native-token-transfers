module ntt_common::bitmap {
    const MAX_U128: u128 = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF;

    public struct Bitmap has store, drop, copy {
        bitmap: u128,
    }

    public fun empty(): Bitmap {
        Bitmap { bitmap: 0 }
    }

    public fun and(a: &Bitmap, b: &Bitmap): Bitmap {
        Bitmap { bitmap: a.bitmap & b.bitmap }
    }

    public fun enable(bitmap: &mut Bitmap, index: u8) {
        let bitmask = 1 << index;
        bitmap.bitmap = bitmap.bitmap | bitmask
    }

    public fun disable(bitmap: &mut Bitmap, index: u8) {
        let bitmask = 1 << index;
        bitmap.bitmap = bitmap.bitmap & (bitmask ^ MAX_U128)
    }

    public fun get(bitmap: &Bitmap, index: u8): bool {
        let bitmask = 1 << index;
        bitmap.bitmap & bitmask > 0
    }

    public fun count_ones(bitmap: &Bitmap): u8 {
        let mut count = 0;
        let mut mask = 1;
        let mut i = 0;
        while (i < 128) {
            if (bitmap.bitmap & mask > 0) {
                count = count + 1;
            };
            mask = mask << 1;
            i = i + 1;
        };
        count
    }

    #[test]
    public fun test_count_ones() {
        let all = Bitmap { bitmap: MAX_U128 };
        assert!(count_ones(&all) == 128);

        let none = Bitmap { bitmap: 0 };
        assert!(count_ones(&none) == 0);

        let seven = Bitmap { bitmap: 2u128.pow(7) - 1 };
        assert!(count_ones(&seven) == 7);
    }
}
