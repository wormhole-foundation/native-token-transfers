(use-trait sip-010-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)
(use-trait ntt-manager-trait .ntt-manager-trait-v1.ntt-manager-trait)
(use-trait wormhole-core-trait .wormhole-trait-core-v2.core-trait)

;; Used by to recieve messages from off-chain Wormhole relayers
(define-trait wormhole-receiver-trait (
  ;; Recieve token transfer VAA as raw bytes
  (receive-token-transfer (
      <wormhole-core-trait> ;; Wormhole core contract
      <ntt-manager-trait>   ;; NTT manager
      <sip-010-trait>       ;; Token contract
      (buff 4096))          ;; VAA as bytes
    (response {
      source-chain: (buff 2),
      sender: (buff 32),
      recipient-addr32: (buff 32),
      recipient: principal,
      amount: uint,
      uid: (buff 32)
    } uint))))
