module.exports = {
  presets: ['module:@react-native/babel-preset'],
  // claude: Reanimated 4 worklets; must stay the last plugin.
  plugins: ['react-native-worklets/plugin'],
};
