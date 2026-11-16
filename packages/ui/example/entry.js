import { Laboratory } from './laboratory.js'

const { React, mount } = window.scholarseedUI
mount((state) => React.createElement(Laboratory, { state }))
