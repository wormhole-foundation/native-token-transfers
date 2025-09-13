/// M Portal Transceiver Interface
/// 
/// Implements the standard transceiver interface for M Token Portal integration.
/// Provides the transceiver type identifier for SDK compatibility.
module sui_m::portal_transceiver {
    
    /// Returns the transceiver type identifier for M Portal
    /// This follows the NTT transceiver interface standard
    public fun get_transceiver_type(): vector<u8> {
        b"m_portal"
    }
}