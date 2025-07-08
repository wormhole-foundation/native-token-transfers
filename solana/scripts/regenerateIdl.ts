import { type Idl } from "@coral-xyz/anchor";
import fs from "fs";

const jsonPath = process.argv[2];
if (jsonPath === undefined) {
  console.error(`Usage:\
${process.argv[0]} ${process.argv[1]} <idl.json>`);
  process.exit(1);
}

// snake to title case
const titleCase = (str: string) =>
  str
    .split("_")
    .map((word) =>
      word.length > 0 && word[0]
        ? word[0].toUpperCase() + word.slice(1).toLowerCase()
        : ""
    )
    .join("");

const idl = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as Idl;

const name = titleCase(idl["name"]);

idl.accounts?.forEach((account) => {
  // NOTE: here we translate PascalCase to camelCase, with the exception of all
  // uppercase account names, such as 'LUT', which we want to preserve.
  //
  // The translation needs to be done because anchor generates an invalid IDL file, so we patch it.
  // Anchor handles all uppercase account names specially (when generating the account discriminator),
  // so we need to preserve them.
  if (!account.name.match(/^[A-Z]+$/)) {
    account.name = account.name.replace(/^[A-Z]+/, (match) =>
      match.toLowerCase()
    );
  }
});

// heredoc
const ts = `\
export type ${name} = ${JSON.stringify(idl, null, 2)}\

export const IDL: ${name} = ${JSON.stringify(idl, null, 2)}
`;

console.log(ts);
