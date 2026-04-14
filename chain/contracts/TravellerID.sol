// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract TravellerID {
    struct TouristID {
        uint256 id;
        string kyc;
        string itinerary;
        string emergencyContact;
        uint256 validUntil;
    }

    mapping(address => TouristID) public touristIds;
    uint256 public idCounter = 0;

    function createTouristId(
        string memory kyc,
        string memory itinerary,
        string memory emergencyContact,
        uint256 validUntil
    ) public {
        idCounter++;
        touristIds[msg.sender] = TouristID(
            idCounter,
            kyc,
            itinerary,
            emergencyContact,
            validUntil
        );
    }
}
