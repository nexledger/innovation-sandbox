package main

import (
	"bytes"
	"encoding/gob"

	"github.com/hyperledger/fabric/core/chaincode/shim"
	pb "github.com/hyperledger/fabric/protos/peer"
)

func Invoke(stub shim.ChaincodeStubInterface, target func(shim.ChaincodeStubInterface, []string) pb.Response) pb.Response {
	items := make([][][]byte, 0)
	if err := decode(stub.GetArgs()[1], &items); err != nil {
		return shim.Error("Failed to unmarshal request")
	}

	itemSize := len(items)
	payloads := make([][]byte, itemSize, itemSize)
	for i, item := range items {
		argsSize := len(item)
		args := make([]string, argsSize, argsSize)
		for j, arg := range item {
			args[j] = string(arg)
		}

		result := target(stub, args)
		if result.Status == shim.ERROR {
			return shim.Error("Failed to invoke: " + result.Message)
		}
		payloads[i] = result.Payload
	}

	response, err := encode(payloads)
	if err != nil {
		return shim.Error("Failed to marshal response")
	}
	return shim.Success(response)
}

func encode(v interface{}) ([]byte, error) {
	buf := new(bytes.Buffer)
	if err := gob.NewEncoder(buf).Encode(v); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func decode(d []byte, v interface{}) error {
	buf := bytes.NewBuffer(d)
	if err := gob.NewDecoder(buf).Decode(v); err != nil {
		return err
	}
	return nil
}
