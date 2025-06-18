export type ExampleNttWithExecutor = {
  version: "0.1.0";
  name: "example_ntt_with_executor";
  instructions: [
    {
      name: "relayNttMesage";
      accounts: [
        {
          name: "payer";
          isMut: true;
          isSigner: true;
        },
        {
          name: "payee";
          isMut: true;
          isSigner: false;
        },
        {
          name: "nttProgramId";
          isMut: false;
          isSigner: false;
        },
        {
          name: "nttPeer";
          isMut: false;
          isSigner: false;
        },
        {
          name: "nttMessage";
          isMut: false;
          isSigner: false;
        },
        {
          name: "executorProgram";
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
          name: "args";
          type: {
            defined: "relayNttMessageArgs";
          };
        }
      ];
    }
  ];
  types: [
    {
      name: "relayNttMessageArgs";
      type: {
        kind: "struct";
        fields: [
          {
            name: "recipientChain";
            type: "u16";
          },
          {
            name: "execAmount";
            type: "u64";
          },
          {
            name: "signedQuoteBytes";
            type: "bytes";
          },
          {
            name: "relayInstructions";
            type: "bytes";
          }
        ];
      };
    }
  ];
};

export const ExampleNttWithExecutorIdl: ExampleNttWithExecutor = {
  version: "0.1.0",
  name: "example_ntt_with_executor",
  instructions: [
    {
      name: "relayNttMesage",
      accounts: [
        {
          name: "payer",
          isMut: true,
          isSigner: true,
        },
        {
          name: "payee",
          isMut: true,
          isSigner: false,
        },
        {
          name: "nttProgramId",
          isMut: false,
          isSigner: false,
        },
        {
          name: "nttPeer",
          isMut: false,
          isSigner: false,
        },
        {
          name: "nttMessage",
          isMut: false,
          isSigner: false,
        },
        {
          name: "executorProgram",
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
          name: "args",
          type: {
            defined: "relayNttMessageArgs",
          },
        },
      ],
    },
  ],
  types: [
    {
      name: "relayNttMessageArgs",
      type: {
        kind: "struct",
        fields: [
          {
            name: "recipientChain",
            type: "u16",
          },
          {
            name: "execAmount",
            type: "u64",
          },
          {
            name: "signedQuoteBytes",
            type: "bytes",
          },
          {
            name: "relayInstructions",
            type: "bytes",
          },
        ],
      },
    },
  ],
};
