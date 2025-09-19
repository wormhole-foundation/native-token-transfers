export type WormholePostMessageShim = {
  "version": "0.0.0",
  "name": "wormhole_post_message_shim",
  "instructions": [
    {
      "name": "postMessage",
      "accounts": [
        {
          "name": "bridge",
          "isMut": true,
          "isSigner": false,
        },
        {
          "name": "message",
          "isMut": true,
          "isSigner": false,
        },
        {
          "name": "emitter",
          "isMut": false,
          "isSigner": true
        },
        {
          "name": "sequence",
          "isMut": true,
          "isSigner": false,
        },
        {
          "name": "payer",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "feeCollector",
          "isMut": true,
          "isSigner": false,
        },
        {
          "name": "clock",
          "isMut": false,
          "isSigner": false,
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false,
        },
        {
          "name": "wormholeProgram",
          "isMut": false,
          "isSigner": false,
        },
        {
          "name": "eventAuthority",
          "isMut": false,
          "isSigner": false,
        },
        {
          "name": "program",
          "isMut": false,
          "isSigner": false,
        }
      ],
      "args": [
        {
          "name": "nonce",
          "type": "u32"
        },
        {
          "name": "consistencyLevel",
          "type": {
            "defined": "finality"
          }
        },
        {
          "name": "payload",
          "type": "bytes"
        }
      ]
    }
  ],
  "events": [
    {
      "name": "messageEvent",
      "fields": [
          {
            "name": "emitter",
            "type": "publicKey",
            "index": false,
          },
          {
            "name": "sequence",
            "type": "u64",
            "index": false,
          },
          {
            "name": "submissionTime",
            "type": "u32",
            "index": false,
          }
        ]
    }
  ],
  "types": [
    {
      "name": "finality",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "confirmed"
          },
          {
            "name": "finalized"
          }
        ]
      }
    },
  ]
};

export const IDL: WormholePostMessageShim = {
  "version": "0.0.0",
  "name": "wormhole_post_message_shim",
  "instructions": [
    {
      "name": "postMessage",
      "accounts": [
        {
          "name": "bridge",
          "isMut": true,
          "isSigner": false,
        },
        {
          "name": "message",
          "isMut": true,
          "isSigner": false,
        },
        {
          "name": "emitter",
          "isMut": false,
          "isSigner": true
        },
        {
          "name": "sequence",
          "isMut": true,
          "isSigner": false,
        },
        {
          "name": "payer",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "feeCollector",
          "isMut": true,
          "isSigner": false,
        },
        {
          "name": "clock",
          "isMut": false,
          "isSigner": false,
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false,
        },
        {
          "name": "wormholeProgram",
          "isMut": false,
          "isSigner": false,
        },
        {
          "name": "eventAuthority",
          "isMut": false,
          "isSigner": false,
        },
        {
          "name": "program",
          "isMut": false,
          "isSigner": false,
        }
      ],
      "args": [
        {
          "name": "nonce",
          "type": "u32"
        },
        {
          "name": "consistencyLevel",
          "type": {
            "defined": "finality"
          }
        },
        {
          "name": "payload",
          "type": "bytes"
        }
      ]
    }
  ],
  "events": [
    {
      "name": "messageEvent",
      "fields": [
          {
            "name": "emitter",
            "type": "publicKey",
            "index": false,
          },
          {
            "name": "sequence",
            "type": "u64",
            "index": false,
          },
          {
            "name": "submissionTime",
            "type": "u32",
            "index": false,
          }
        ]
    }
  ],
  "types": [
    {
      "name": "finality",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "confirmed"
          },
          {
            "name": "finalized"
          }
        ]
      }
    },
  ]
};