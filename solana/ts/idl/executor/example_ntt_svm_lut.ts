export type ExampleNttSvmLut = {
  version: "0.1.0";
  name: "example_ntt_svm_lut";
  instructions: [
    {
      name: "initializeLut";
      accounts: [
        {
          name: "payer";
          isMut: true;
          isSigner: true;
        },
        {
          name: "nttProgramId";
          isMut: false;
          isSigner: false;
        },
        {
          name: "nttConfig";
          isMut: false;
          isSigner: false;
        },
        {
          name: "authority";
          isMut: false;
          isSigner: false;
        },
        {
          name: "lutAddress";
          isMut: true;
          isSigner: false;
        },
        {
          name: "lut";
          isMut: true;
          isSigner: false;
        },
        {
          name: "lutProgram";
          isMut: false;
          isSigner: false;
        },
        {
          name: "systemProgram";
          isMut: false;
          isSigner: false;
        }
      ];
      args: [
        {
          name: "recentSlot";
          type: "u64";
        }
      ];
    }
  ];
  accounts: [
    {
      name: "LUT";
      type: {
        kind: "struct";
        fields: [
          {
            name: "bump";
            type: "u8";
          },
          {
            name: "address";
            type: "publicKey";
          }
        ];
      };
    }
  ];
};

export const ExampleNttSvmLutIdl: ExampleNttSvmLut = {
  version: "0.1.0",
  name: "example_ntt_svm_lut",
  instructions: [
    {
      name: "initializeLut",
      accounts: [
        {
          name: "payer",
          isMut: true,
          isSigner: true,
        },
        {
          name: "nttProgramId",
          isMut: false,
          isSigner: false,
        },
        {
          name: "nttConfig",
          isMut: false,
          isSigner: false,
        },
        {
          name: "authority",
          isMut: false,
          isSigner: false,
        },
        {
          name: "lutAddress",
          isMut: true,
          isSigner: false,
        },
        {
          name: "lut",
          isMut: true,
          isSigner: false,
        },
        {
          name: "lutProgram",
          isMut: false,
          isSigner: false,
        },
        {
          name: "systemProgram",
          isMut: false,
          isSigner: false,
        },
      ],
      args: [
        {
          name: "recentSlot",
          type: "u64",
        },
      ],
    },
  ],
  accounts: [
    {
      name: "LUT",
      type: {
        kind: "struct",
        fields: [
          {
            name: "bump",
            type: "u8",
          },
          {
            name: "address",
            type: "publicKey",
          },
        ],
      },
    },
  ],
};
