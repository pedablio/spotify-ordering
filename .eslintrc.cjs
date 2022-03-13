module.exports = {
  env: { node: true },
  plugins: ['prettier'],
  extends: ['standard', 'prettier'],
  rules: {
    'comma-dangle': ['error', 'always-multiline'],
    'prettier/prettier': 'error',
    'object-shorthand': ['error', 'always'],
    'require-await': 'error',
    'no-useless-constructor': 'off',
    'space-before-function-paren': 'off',
    indent: 'off',
  },
}
