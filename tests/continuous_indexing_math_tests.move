module sui_m::continuous_indexing_math_tests {
    use sui_m::continuous_indexing_math::{
        divide_down,
        divide_up,
        multiply_down,
        multiply_up
    };
    
    const EXP_SCALED_ONE: u64 = 1_000_000_000_000; // 1e12
    
    #[test]
    fun test_divide_down() {
        // Set 1a
        assert!(divide_down(0u256, 1u128) == 0u128, 0);
        assert!(divide_down(1u256, 1u128) == (EXP_SCALED_ONE as u128), 0);
        assert!(divide_down(2u256, 1u128) == (2 * EXP_SCALED_ONE as u128), 0);
        assert!(divide_down(3u256, 1u128) == (3 * EXP_SCALED_ONE as u128), 0);
        
        // Set 1b
        assert!(divide_down(1u256, 1u128) == (EXP_SCALED_ONE as u128), 0);
        assert!(divide_down(1u256, 2u128) == (EXP_SCALED_ONE / 2 as u128), 0);
        assert!(divide_down(1u256, 3u128) == (EXP_SCALED_ONE / 3 as u128), 0); // Different than divideUp
        
        // Set 2a
        assert!(divide_down(0u256, 10u128) == 0u128, 0);
        assert!(divide_down(5u256, 10u128) == (EXP_SCALED_ONE / 2 as u128), 0);
        assert!(divide_down(10u256, 10u128) == (EXP_SCALED_ONE as u128), 0);
        assert!(divide_down(15u256, 10u128) == (EXP_SCALED_ONE + EXP_SCALED_ONE / 2 as u128), 0);
        assert!(divide_down(20u256, 10u128) == (2 * EXP_SCALED_ONE as u128), 0);
        assert!(divide_down(25u256, 10u128) == (2 * EXP_SCALED_ONE + EXP_SCALED_ONE / 2 as u128), 0);
        
        // Set 2b
        assert!(divide_down(10u256, 5u128) == (2 * EXP_SCALED_ONE as u128), 0);
        assert!(divide_down(10u256, 10u128) == (EXP_SCALED_ONE as u128), 0);
        assert!(divide_down(10u256, 15u128) == ((2 * EXP_SCALED_ONE) / 3 as u128), 0); // Different than divideUp
        assert!(divide_down(10u256, 20u128) == (EXP_SCALED_ONE / 2 as u128), 0);
        assert!(divide_down(10u256, 25u128) == ((2 * EXP_SCALED_ONE) / 5 as u128), 0);
        
        // Set 3
        assert!(divide_down(1u256, (EXP_SCALED_ONE + 1 as u128)) == 0u128, 0); // Different than divideUp
        assert!(divide_down(1u256, (EXP_SCALED_ONE as u128)) == 1u128, 0);
        assert!(divide_down(1u256, (EXP_SCALED_ONE - 1 as u128)) == 1u128, 0); // Different than divideUp
        assert!(divide_down(1u256, ((EXP_SCALED_ONE / 2) + 1 as u128)) == 1u128, 0); // Different than divideUp
        assert!(divide_down(1u256, (EXP_SCALED_ONE / 2 as u128)) == 2u128, 0);
        assert!(divide_down(1u256, ((EXP_SCALED_ONE / 2) - 1 as u128)) == 2u128, 0); // Different than divideUp
    }
    
    #[test]
    fun test_divide_up() {
        // Set 1a
        assert!(divide_up(0u256, 1u128) == 0u128, 0);
        assert!(divide_up(1u256, 1u128) == (EXP_SCALED_ONE as u128), 0);
        assert!(divide_up(2u256, 1u128) == (2 * EXP_SCALED_ONE as u128), 0);
        assert!(divide_up(3u256, 1u128) == (3 * EXP_SCALED_ONE as u128), 0);
        
        // Set 1b
        assert!(divide_up(1u256, 1u128) == (EXP_SCALED_ONE as u128), 0);
        assert!(divide_up(1u256, 2u128) == (EXP_SCALED_ONE / 2 as u128), 0);
        assert!(divide_up(1u256, 3u128) == (EXP_SCALED_ONE / 3 + 1 as u128), 0); // Different than divideDown
        
        // Set 2a
        assert!(divide_up(0u256, 10u128) == 0u128, 0);
        assert!(divide_up(5u256, 10u128) == (EXP_SCALED_ONE / 2 as u128), 0);
        assert!(divide_up(10u256, 10u128) == (EXP_SCALED_ONE as u128), 0);
        assert!(divide_up(15u256, 10u128) == (EXP_SCALED_ONE + EXP_SCALED_ONE / 2 as u128), 0);
        assert!(divide_up(20u256, 10u128) == (2 * EXP_SCALED_ONE as u128), 0);
        assert!(divide_up(25u256, 10u128) == (2 * EXP_SCALED_ONE + EXP_SCALED_ONE / 2 as u128), 0);
        
        // Set 2b
        assert!(divide_up(10u256, 5u128) == (2 * EXP_SCALED_ONE as u128), 0);
        assert!(divide_up(10u256, 10u128) == (EXP_SCALED_ONE as u128), 0);
        assert!(divide_up(10u256, 15u128) == ((2 * EXP_SCALED_ONE) / 3 + 1 as u128), 0); // Different than divideDown
        assert!(divide_up(10u256, 20u128) == (EXP_SCALED_ONE / 2 as u128), 0);
        assert!(divide_up(10u256, 25u128) == ((2 * EXP_SCALED_ONE) / 5 as u128), 0);
        
        // Set 3
        assert!(divide_up(1u256, (EXP_SCALED_ONE + 1 as u128)) == 1u128, 0); // Different than divideDown
        assert!(divide_up(1u256, (EXP_SCALED_ONE as u128)) == 1u128, 0);
        assert!(divide_up(1u256, (EXP_SCALED_ONE - 1 as u128)) == 2u128, 0); // Different than divideDown
        assert!(divide_up(1u256, ((EXP_SCALED_ONE / 2) + 1 as u128)) == 2u128, 0); // Different than divideDown
        assert!(divide_up(1u256, (EXP_SCALED_ONE / 2 as u128)) == 2u128, 0);
        assert!(divide_up(1u256, ((EXP_SCALED_ONE / 2) - 1 as u128)) == 3u128, 0); // Different than divideDown
    }
    
    #[test]
    fun test_multiply_down() {
        // Set 1a
        assert!(multiply_down(0u128, 1u128) == 0u256, 0);
        assert!(multiply_down((EXP_SCALED_ONE as u128), 1u128) == 1u256, 0);
        assert!(multiply_down((2 * EXP_SCALED_ONE as u128), 1u128) == 2u256, 0);
        assert!(multiply_down((3 * EXP_SCALED_ONE as u128), 1u128) == 3u256, 0);
        
        // Set 1b
        assert!(multiply_down((EXP_SCALED_ONE as u128), 1u128) == 1u256, 0);
        assert!(multiply_down((EXP_SCALED_ONE / 2 as u128), 2u128) == 1u256, 0);
        assert!(multiply_down((EXP_SCALED_ONE / 3 as u128), 3u128) == 0u256, 0);
        assert!(multiply_down((EXP_SCALED_ONE / 3 + 1 as u128), 3u128) == 1u256, 0);
        
        // Set 2a
        assert!(multiply_down(0u128, 10u128) == 0u256, 0);
        assert!(multiply_down((EXP_SCALED_ONE / 2 as u128), 10u128) == 5u256, 0);
        assert!(multiply_down((EXP_SCALED_ONE as u128), 10u128) == 10u256, 0);
        assert!(multiply_down((EXP_SCALED_ONE + EXP_SCALED_ONE / 2 as u128), 10u128) == 15u256, 0);
        assert!(multiply_down((2 * EXP_SCALED_ONE as u128), 10u128) == 20u256, 0);
        assert!(multiply_down((2 * EXP_SCALED_ONE + EXP_SCALED_ONE / 2 as u128), 10u128) == 25u256, 0);
        
        // Set 2b
        assert!(multiply_down((2 * EXP_SCALED_ONE as u128), 5u128) == 10u256, 0);
        assert!(multiply_down((EXP_SCALED_ONE as u128), 10u128) == 10u256, 0);
        assert!(multiply_down(((2 * EXP_SCALED_ONE) / 3 as u128), 15u128) == 9u256, 0);
        assert!(multiply_down(((2 * EXP_SCALED_ONE) / 3 + 1 as u128), 15u128) == 10u256, 0);
        assert!(multiply_down((EXP_SCALED_ONE / 2 as u128), 20u128) == 10u256, 0);
        assert!(multiply_down(((2 * EXP_SCALED_ONE) / 5 as u128), 25u128) == 10u256, 0);
        
        // Set 3
        assert!(multiply_down(1u128, (EXP_SCALED_ONE + 1 as u128)) == 1u256, 0);
        assert!(multiply_down(1u128, (EXP_SCALED_ONE as u128)) == 1u256, 0);
        assert!(multiply_down(1u128, (EXP_SCALED_ONE - 1 as u128)) == 0u256, 0);
        assert!(multiply_down(1u128, ((EXP_SCALED_ONE / 2) + 1 as u128)) == 0u256, 0);
        assert!(multiply_down(2u128, (EXP_SCALED_ONE / 2 as u128)) == 1u256, 0);
        assert!(multiply_down(2u128, ((EXP_SCALED_ONE / 2) - 1 as u128)) == 0u256, 0);
    }
    
    #[test]
    fun test_multiply_up() {
        // Set 1a
        assert!(multiply_up(0u128, 1u128) == 0u256, 0);
        assert!(multiply_up((EXP_SCALED_ONE as u128), 1u128) == 1u256, 0);
        assert!(multiply_up((2 * EXP_SCALED_ONE as u128), 1u128) == 2u256, 0);
        assert!(multiply_up((3 * EXP_SCALED_ONE as u128), 1u128) == 3u256, 0);
        
        // Set 1b
        assert!(multiply_up((EXP_SCALED_ONE as u128), 1u128) == 1u256, 0);
        assert!(multiply_up((EXP_SCALED_ONE / 2 as u128), 2u128) == 1u256, 0);
        assert!(multiply_up((EXP_SCALED_ONE / 3 as u128), 3u128) == 1u256, 0); // Different than multiplyDown
        assert!(multiply_up((EXP_SCALED_ONE / 3 + 1 as u128), 3u128) == 2u256, 0); // Different than multiplyDown
        
        // Set 2a
        assert!(multiply_up(0u128, 10u128) == 0u256, 0);
        assert!(multiply_up((EXP_SCALED_ONE / 2 as u128), 10u128) == 5u256, 0);
        assert!(multiply_up((EXP_SCALED_ONE as u128), 10u128) == 10u256, 0);
        assert!(multiply_up((EXP_SCALED_ONE + EXP_SCALED_ONE / 2 as u128), 10u128) == 15u256, 0);
        assert!(multiply_up((2 * EXP_SCALED_ONE as u128), 10u128) == 20u256, 0);
        assert!(multiply_up((2 * EXP_SCALED_ONE + EXP_SCALED_ONE / 2 as u128), 10u128) == 25u256, 0);
        
        // Set 2b
        assert!(multiply_up((2 * EXP_SCALED_ONE as u128), 5u128) == 10u256, 0);
        assert!(multiply_up((EXP_SCALED_ONE as u128), 10u128) == 10u256, 0);
        assert!(multiply_up(((2 * EXP_SCALED_ONE) / 3 as u128), 15u128) == 10u256, 0); // Different than multiplyDown
        assert!(multiply_up(((2 * EXP_SCALED_ONE) / 3 + 1 as u128), 15u128) == 11u256, 0); // Different than multiplyDown
        assert!(multiply_up((EXP_SCALED_ONE / 2 as u128), 20u128) == 10u256, 0);
        assert!(multiply_up(((2 * EXP_SCALED_ONE) / 5 as u128), 25u128) == 10u256, 0);
        
        // Set 3
        assert!(multiply_up(1u128, (EXP_SCALED_ONE + 1 as u128)) == 2u256, 0); // Different than multiplyDown
        assert!(multiply_up(1u128, (EXP_SCALED_ONE as u128)) == 1u256, 0);
        assert!(multiply_up(1u128, (EXP_SCALED_ONE - 1 as u128)) == 1u256, 0); // Different than multiplyDown
        assert!(multiply_up(1u128, ((EXP_SCALED_ONE / 2) + 1 as u128)) == 1u256, 0); // Different than multiplyDown
        assert!(multiply_up(2u128, (EXP_SCALED_ONE / 2 as u128)) == 1u256, 0);
        assert!(multiply_up(2u128, ((EXP_SCALED_ONE / 2) - 1 as u128)) == 1u256, 0); // Different than multiplyDown
    }
    
    #[test]
    #[expected_failure(abort_code = sui_m::continuous_indexing_math::EDivisionByZero)]
    fun test_divide_by_zero_down() {
        divide_down(1000u256, 0u128);
    }
    
    #[test]
    #[expected_failure(abort_code = sui_m::continuous_indexing_math::EDivisionByZero)]
    fun test_divide_by_zero_up() {
        divide_up(1000u256, 0u128);
    }
}