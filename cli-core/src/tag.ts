import type { Platform } from "@wormhole-foundation/sdk"
import { execSync } from "child_process"

export function getAvailableVersions<P extends Platform>(platform: P): string[] {
    const tags = execSync(`git tag --list 'v*+${platform.toLowerCase()}'`, {
        stdio: ["ignore", null, null]
    }).toString().trim().split("\n")
    return tags.map(tag => tag.split("+")[0].slice(1))
}

export function getGitTagName<P extends Platform>(platform: P, version: string): string | undefined {
    const found = execSync(`git tag --list 'v${version}+${platform.toLowerCase()}'`, {
        stdio: ["ignore", null, null]
    }).toString().trim()
    return found
}
