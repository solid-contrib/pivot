# Shape validation module

This repository contains an external component that can be injected into the [Community Solid Server](https://github.com/CommunitySolidServer/CommunitySolidServer/) (CSS).
It allows to constrain an [`ldp:Container`](https://www.w3.org/TR/ldp/) to only have resources that conform to a given shape. 

Instructions on how to constrain a given container can be found [here](documentation/constrained-containers.md).

## Running the server

Clone this repository, then install the packages
```sh
npm i
```
To run the server with your current folder as storage, use:
```sh
npm run start
```

Configurations for in-memory storage and file storage without setup are also provided.

## Feedback and questions

Do not hesitate to [report a bug](https://github.com/CommunitySolidServer/shape-validator-component/issues).

Further questions can also be asked to [Wout Slabbinck](mailto:wout.slabbinck@ugent.be) (developer and maintainer of this repository).
