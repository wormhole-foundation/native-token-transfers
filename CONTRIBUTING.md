# CONTRIBUTING

- All new dependencies must be justified in your pull request, explaining why the functionality cannot be reasonably implemented in-house or with existing dependencies, as each dependency increases our attack surface and maintenance burden. Look into the dependency, verify its maintenance status, and ensure the convenience truly outweighs the risk.
- PRs that only correct typos or make minor wording adjustments will be rejected. Fixing typos alongside other non-trivial engineering work is welcome.
- Pull requests that modify dependencies must be well-documented so that the benefits of updating can be weighed against
  security and compatibility concerns. Low-effort PRs that update dependencies without any documentation will be rejected.

## Supply Chain Security


### Core Principles
- **Pin as much as possible**: Versions, hashes, and dependencies
- **Minimize attack surface**: Fewer dependencies = fewer risks
- **Verify integrity**: Use lockfiles and checksums

### Working with Node dependencies
Do not change the dependencies of the package.json by hand! 

Instead:

- When initially installing OR pulling what has been changed: `npm ci`. 
If you do not do this, you may not get exactly what is specified in the file, inadvertently update dependencies, or even pull exploits down to your machine! **Never use `npm install` for this use case**.
- When needing to add or update a package: `npm i <package>@<version>`. If you do not do this, you may inadvertently update other packages or fail to update the lock file.
- When needing to remove a package: `npm r <package>`. If you do not do this, you may inadvertently update other packages or fail to update the lock file.

Always commit your `package-lock.json`.

Using specific versions improves security because package versions cannot be overwritten after they are released.

#### Dockerfile workflow

##### If installing a package locally

- Copy in package.json and the lock file
- Then run `npm ci`

```dockerfile
# NOTE: Dockerfile must be pinned too
FROM node:18.19.0-alpine@sha256:12345...

WORKDIR /app

# Include package files
COPY package.json package-lock.json ./

# Use npm ci so that packages are not upgraded
RUN npm ci

...
```

##### If installing a package globally

- Use `npm i <package>@<version>`

```dockerfile
# NOTE: Dockerfile must be pinned too
FROM node:18.19.0-alpine@sha256:12345...

# Pin global packages to specific versions
RUN npm install -g somepackage@1.2.3

...

```

### When to update packages
Updating packages should not be done alongside other work. Instead, take the time to review dependency upgrades carefully,
making a best effort to ensure that they are necessary and secure.
