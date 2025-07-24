export type WormholeVerifyVaaShim = {
  "version": "0.0.0",
  "name": "wormholeVerifyVaaShim",
  "instructions": [
    {
      "name": "closeSignatures",
      "accounts": [
        {
          "name": "guardianSignatures",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "refundRecipient",
          "isMut": true,
          "isSigner": true,
        }
      ],
      "args": []
    },
    {
      "name": "postSignatures",
      "accounts": [
        {
          "name": "payer",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "guardianSignatures",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "guardianSetIndex",
          "type": "u32"
        },
        {
          "name": "totalSignatures",
          "type": "u8"
        },
        {
          "name": "guardianSignatures",
          "type": {
            "vec": {
              "array": [
                "u8",
                66
              ]
            }
          }
        }
      ]
    },
    {
      "name": "verifyHash",
      "accounts": [
        {
          "name": "guardianSet",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "guardianSignatures",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "guardianSetBump",
          "type": "u8"
        },
        {
          "name": "digest",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "guardianSignatures",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "refundRecipient",
            "type": "publicKey"
          },
          {
            "name": "guardianSetIndexBe",
            "type": {
              "array": [
                "u8",
                4
              ]
            }
          },
          {
            "name": "guardianSignatures",
            "type": {
              "vec": {
                "array": [
                  "u8",
                  66
                ]
              }
            }
          }
        ]
      }
    }
  ],
};

export const IDL: WormholeVerifyVaaShim = {
  "version": "0.0.0",
  "name": "wormholeVerifyVaaShim",
  "instructions": [
    {
      "name": "closeSignatures",
      "accounts": [
        {
          "name": "guardianSignatures",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "refundRecipient",
          "isMut": true,
          "isSigner": true,
        }
      ],
      "args": []
    },
    {
      "name": "postSignatures",
      "accounts": [
        {
          "name": "payer",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "guardianSignatures",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "guardianSetIndex",
          "type": "u32"
        },
        {
          "name": "totalSignatures",
          "type": "u8"
        },
        {
          "name": "guardianSignatures",
          "type": {
            "vec": {
              "array": [
                "u8",
                66
              ]
            }
          }
        }
      ]
    },
    {
      "name": "verifyHash",
      "accounts": [
        {
          "name": "guardianSet",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "guardianSignatures",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "guardianSetBump",
          "type": "u8"
        },
        {
          "name": "digest",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "guardianSignatures",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "refundRecipient",
            "type": "publicKey"
          },
          {
            "name": "guardianSetIndexBe",
            "type": {
              "array": [
                "u8",
                4
              ]
            }
          },
          {
            "name": "guardianSignatures",
            "type": {
              "vec": {
                "array": [
                  "u8",
                  66
                ]
              }
            }
          }
        ]
      }
    }
  ],
};
  