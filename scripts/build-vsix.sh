#!/usr/bin/env bash

# Exit immediately if a command exits with a non-zero status
set -e

# This script lives in scripts/, but npm and vsce must run against the repo ROOT — that is where
# package.json lives and where the .vsix is written. Anchor there, whatever the caller's cwd.
cd "$(dirname "$0")/.."

echo "🚀 Starting VS Code Extension packaging process..."

# 1. Ensure Node.js and npm are installed
if ! command -v npm &> /dev/null; then
    echo "❌ Error: npm is not installed. Please install Node.js first."
    exit 1
fi

# 2. Check or install the official VSCE tool
if ! command -v npx &> /dev/null; then
    echo "📦 Installing @vscode/vsce globally..."
    npm install -g @vscode/vsce
    VSCE_CMD="vsce"
else
    # Prefer running via npx to ensure we use the latest/correct version without global bloat
    VSCE_CMD="npx @vscode/vsce"
fi

# 3. Clean previous builds and install production dependencies
echo "🧹 Cleaning old artifacts and installing workspace dependencies..."
rm -rf out/ dist/ *.vsix
npm install

# 4. Compile the source code (TypeScript/Webpack compile steps usually run here)
# Most VS Code boilerplates use 'npm run compile' or 'npm run package'
if npm run | grep -q "compile"; then
    echo "🏗️  Compiling codebase..."
    npm run compile
elif npm run | grep -q "build"; then
    echo "🏗️  Building codebase..."
    npm run build
fi

# 5. Pack the codebase into a .vsix file
echo "📦 Packaging extension into a .vsix file..."
# The --no-dependencies flag packages faster if you've already handled npm install
$VSCE_CMD package

echo "✅ Success! Your .vsix package is ready in the root folder."
ls *.vsix