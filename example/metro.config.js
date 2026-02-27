const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "..");
const projectNodeModules = path.resolve(projectRoot, "node_modules");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.disableHierarchicalLookup = true;
config.resolver.nodeModulesPaths = [projectNodeModules];
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  "react-native-liveline": workspaceRoot,
  react: path.resolve(projectNodeModules, "react"),
  "react-native": path.resolve(projectNodeModules, "react-native"),
  "react-native-reanimated": path.resolve(
    projectNodeModules,
    "react-native-reanimated",
  ),
  "react-native-gesture-handler": path.resolve(
    projectNodeModules,
    "react-native-gesture-handler",
  ),
  "@shopify/react-native-skia": path.resolve(
    projectNodeModules,
    "@shopify/react-native-skia",
  ),
};

module.exports = config;
